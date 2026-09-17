import type { VMHookContext } from "../_lib/hook_context";

/**
 * Plex Media Server appliance, after the guest is ready: claims the new
 * server on the Plex account the user signed into, names it, and keeps the
 * server's own access token for the platform.
 *
 * What it changes on the guest, and nothing else: the claim (only on a server
 * whose identity says it is not yet claimed) and the friendly name (only on a
 * server plex.tv lists as owned by the signed-in account). An existing claim
 * is never touched: a server already claimed is named and its token kept if
 * the account owns it, and the hook stops before any write if the account
 * does not own it or plex.tv does not list it — a shared server, or someone
 * else's. An identity that does not say whether the server is claimed is not
 * proof that it is unclaimed, and stops the hook too. The five libraries use
 * the appliance's default HexOS mounts, with trash emptying disabled and scans requested.
 *
 * Two tokens are involved and they are not interchangeable. The pin flow
 * yields the account token, which authorises the claim. The credential kept
 * for the platform is the server's access token from plex.tv's resources
 * listing, matched by the server's own machine identifier: for an owned
 * server it happens to equal the account token, for a shared one it does
 * not, and the widget that later queries the server needs the server's.
 * Both go to the guest as headers, never in a path, so no error text or log
 * line carries them; the claim token, single-use and short-lived, is the one
 * thing Plex insists on reading from the query string, and a failed claim is
 * logged by its error's kind rather than its message for that reason.
 *
 * plex.tv itself is reached with the runtime's own fetch, as the app-side
 * Plex hook does: it is not the guest, and the guest transport is for the
 * guest alone.
 */

/** The identifier this product signs in under; the declaration's pin flow uses the same one. */
export const CLIENT_IDENTIFIER = "hexos-platform";
/** Where the server's access token is kept, bound to this VM instance. */
export const SERVER_TOKEN_SECRET = "plexServerToken";
export const SIGN_IN_INPUT = "plex_login";
export const SERVER_NAME_INPUT = "server_name";

const PLEX_TV = "https://plex.tv";
const CLAIM_TOKEN_PATH = "/api/claim/token.json";
const RESOURCES_PATH = "/api/v2/resources?includeHttps=1&includeRelay=1";
/** Per-request ceiling on plex.tv, as the app-side hook sets one. */
const PLEX_TV_TIMEOUT_MS = 10000;
/** Attempts at the platform's back-off (5 s growing to 15 s): about six minutes. */
const READY_ATTEMPTS = 24;
export const CLAIM_ATTEMPTS = 3;
const CLAIM_RETRY_MS = 5000;
/** plex.tv lists a freshly claimed server once it has published itself: twelve looks, ten seconds apart. */
export const RESOURCES_ATTEMPTS = 12;
const RESOURCES_RETRY_MS = 10000;
/** Matches the app hook's library types; the first-boot profile mounts each HexOS location here. */
export const LIBRARIES = [
  { name: "Movies", location: "/mnt/movies", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie", language: "en-US", checkpointId: "lib_movies" },
  { name: "TV Shows", location: "/mnt/shows", type: "show", agent: "tv.plex.agents.series", scanner: "Plex TV Series", language: "en-US", checkpointId: "lib_tv" },
  { name: "Music", location: "/mnt/music", type: "artist", agent: "tv.plex.agents.music", scanner: "Plex Music", language: "en-US", checkpointId: "lib_music" },
  { name: "Photos", location: "/mnt/photos", type: "photo", agent: "com.plexapp.agents.none", scanner: "Plex Photo Scanner", language: "xn", checkpointId: "lib_photos" },
  { name: "Videos", location: "/mnt/videos", type: "movie", agent: "com.plexapp.agents.none", scanner: "Plex Video Files Scanner", language: "xn", checkpointId: "lib_videos" },
] as const;
type Library = (typeof LIBRARIES)[number];
/** Plex's section listing and library creation can become ready separately: eight looks, five seconds apart. */
export const LIBRARY_ATTEMPTS = 8;
const LIBRARY_RETRY_MS = 5000;
/** Plex's preference that removes library items whose files went missing at the next scan; off, so an absent share loses nothing. */
const TRASH_PREFERENCE = "autoEmptyTrash";

export interface PlexSection {
  key: string;
  title: string;
  type: string;
  locations: string[];
}

export interface PlexSignIn {
  authToken: string;
}

export interface PlexIdentity {
  machineIdentifier: string;
  claimed: boolean;
  version?: string;
}

/** What plex.tv's resources listing says about one server, by its machine identifier. */
export type PlexListing = { listed: false } | { listed: true; owned: boolean; accessToken?: string };

/** A request to plex.tv: the runtime's fetch, narrowed to what the hook reads, so a test can stand in. */
export type PlexTvFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

const JSON_ACCEPT = { Accept: "application/json" };

const withToken = (authToken: string): Record<string, string> => ({ ...JSON_ACCEPT, "X-Plex-Token": authToken });

const plexTvHeaders = (authToken: string): Record<string, string> => ({
  ...withToken(authToken),
  "X-Plex-Client-Identifier": CLIENT_IDENTIFIER,
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML's `Char` production: what a character reference may name. Surrogates, controls and the two non-characters are not characters. */
const isXmlChar = (code: number): boolean =>
  code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

/** The character a reference names, when it is one of the five entities (by own property) or a permitted numeric reference. */
function referencedCharacter(entity: string): string | undefined {
  if (entity[0] === "#") {
    const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && isXmlChar(code) ? String.fromCodePoint(code) : undefined;
  }
  return Object.hasOwn(XML_ENTITIES, entity) ? XML_ENTITIES[entity] : undefined;
}

const XML_REFERENCE_AT = /^&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/;

/**
 * Whether an attribute value as written is one XML allows: no raw `<`, and
 * every `&` beginning a complete reference the decoder resolves. Text that
 * fails this is not the server's answer and is not read at all, rather than
 * decoded as far as it goes and compared.
 */
export function isWellFormedAttributeValue(raw: string): boolean {
  if (raw.includes("<")) return false;
  let at = raw.indexOf("&");
  while (at !== -1) {
    const match = XML_REFERENCE_AT.exec(raw.slice(at));
    if (!match || referencedCharacter(match[1]) === undefined) return false;
    at = raw.indexOf("&", at + match[0].length);
  }
  return true;
}

/**
 * An XML attribute value as written, with its character references decoded:
 * the five named entities, by own property, and numeric references to the
 * characters XML permits. Anything else stays as written, so a reference to
 * a surrogate, a control or a non-character can never decode into a name the
 * user asked for; the readers below refuse such a value before decoding it.
 */
export function decodeXmlAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => referencedCharacter(entity) ?? whole);
}

function attribute(text: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(text);
  if (!match || !isWellFormedAttributeValue(match[1])) return undefined;
  return decodeXmlAttribute(match[1]);
}

/**
 * Plex's claimed flag in the representations it uses (a JSON boolean, a 0/1,
 * or the strings of either); anything else is not a claim state.
 */
export function readClaimed(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

/**
 * The server's identity as `/identity` reports it, in either of the shapes
 * Plex answers with (JSON when asked, XML otherwise). A document that does
 * not carry both the machine identifier and an explicit claim state is not
 * Plex's identity and reads as undefined rather than as a guess: a missing
 * claim state is not evidence that the server is unclaimed.
 */
export function readIdentity(text: string): PlexIdentity | undefined {
  const parsed = parseJson(text) as { MediaContainer?: Record<string, unknown> } | undefined;
  const container = parsed?.MediaContainer;
  if (container && typeof container === "object") {
    const machineIdentifier = container.machineIdentifier;
    const claimed = readClaimed(container.claimed);
    if (typeof machineIdentifier !== "string" || machineIdentifier.length === 0 || claimed === undefined) return undefined;
    return { machineIdentifier, claimed, version: typeof container.version === "string" ? container.version : undefined };
  }
  const machineIdentifier = attribute(text, "machineIdentifier");
  const claimed = readClaimed(attribute(text, "claimed"));
  if (!machineIdentifier || claimed === undefined) return undefined;
  return { machineIdentifier, claimed, version: attribute(text, "version") };
}

/** The friendly name the server's root document reports. */
export function readFriendlyName(text: string): string | undefined {
  const parsed = parseJson(text) as { MediaContainer?: Record<string, unknown> } | undefined;
  const container = parsed?.MediaContainer;
  if (container && typeof container === "object") {
    return typeof container.friendlyName === "string" ? container.friendlyName : undefined;
  }
  return attribute(text, "friendlyName");
}

/** The single-use claim token plex.tv hands out for the account token. */
export function readClaimToken(text: string): string | undefined {
  const parsed = parseJson(text) as { token?: unknown } | undefined;
  return typeof parsed?.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
}

/**
 * What plex.tv's resources listing says about the server whose
 * `clientIdentifier` is the machine identifier the guest reported: whether it
 * is listed at all (a freshly claimed server may not be yet), whether the
 * signed-in account owns it (a shared server is listed but not owned, and
 * only an explicit `owned: true` counts), and its access token.
 */
export function readServerToken(text: string, machineIdentifier: string): PlexListing {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return { listed: false };
  const server = parsed.find(
    (entry) => typeof entry === "object" && entry !== null && (entry as { clientIdentifier?: unknown }).clientIdentifier === machineIdentifier,
  ) as { owned?: unknown; accessToken?: unknown } | undefined;
  if (!server) return { listed: false };
  const accessToken = server.accessToken;
  return {
    listed: true,
    owned: server.owned === true,
    accessToken: typeof accessToken === "string" && accessToken.length > 0 ? accessToken : undefined,
  };
}

/**
 * The library sections `/library/sections` reports, as JSON: a `Directory`
 * per section with its `key`, `type`, `title` and `Location` list. No
 * `Directory` means no sections. Anything that is not that document reads as
 * undefined, so a subsystem that is still starting is told apart from a
 * server with no libraries.
 */
export function readSections(text: string): PlexSection[] | undefined {
  const parsed = parseJson(text) as { MediaContainer?: { Directory?: unknown } } | undefined;
  const container = parsed?.MediaContainer;
  if (!container || typeof container !== "object") return undefined;
  const directories = container.Directory;
  if (directories === undefined) return [];
  if (!Array.isArray(directories)) return undefined;
  const sections: PlexSection[] = [];
  for (const entry of directories) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { key, title, type, Location } = entry as { key?: unknown; title?: unknown; type?: unknown; Location?: unknown };
    if (typeof key !== "string" || typeof title !== "string" || typeof type !== "string") return undefined;
    const locations: string[] = [];
    for (const location of Array.isArray(Location) ? Location : []) {
      const path = typeof location === "object" && location !== null ? (location as { path?: unknown }).path : undefined;
      if (typeof path === "string") locations.push(path);
    }
    sections.push({ key, title, type, locations });
  }
  return sections;
}

/** One preference's value from `/:/prefs` as JSON (`MediaContainer.Setting[]`), or undefined when it is not listed. */
export function readPreference(text: string, id: string): unknown {
  const parsed = parseJson(text) as { MediaContainer?: { Setting?: unknown } } | undefined;
  const settings = parsed?.MediaContainer?.Setting;
  if (!Array.isArray(settings)) return undefined;
  const setting = settings.find((entry) => typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === id);
  return setting ? (setting as { value?: unknown }).value : undefined;
}

/** The answered server name, or the VM's own name when the question was left blank. */
export function chooseServerName(ctx: Pick<VMHookContext, "inputs" | "vm">): string {
  const answered = ctx.inputs[SERVER_NAME_INPUT];
  if (typeof answered === "string" && answered.trim().length > 0) return answered.trim();
  return ctx.vm.name;
}

/** The account token from the sign-in input: the dialog's result object, or a bare token. */
export function readAccountToken(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "object" && value !== null) {
    const token = (value as { authToken?: unknown }).authToken;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }
  return undefined;
}

/** The kinds the guest transport names on its errors (its `GuestHttpFailureKind`); anything else is reported as "error". */
const GUEST_ERROR_KINDS = new Set([
  "bad-request",
  "unreachable",
  "ambiguous",
  "bound-source-mismatch",
  "redirect-refused",
  "too-many-redirects",
  "body-too-large",
  "aborted",
  "timeout",
  "attempt-failed",
]);

/**
 * What a failed guest request may be logged as: its kind, never its message.
 * A message can carry the URL the transport was asked for, and the claim's
 * URL carries the claim token, in whatever encoding a redirect chose.
 */
export function classifyGuestError(error: unknown): string {
  const kind = typeof error === "object" && error !== null ? (error as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && GUEST_ERROR_KINDS.has(kind) ? kind : "error";
}

/** The folders a media-reconnect firing names, as the platform sends them (`{ folders: string[] }`); undefined when malformed. */
export function readReconnectedFolders(eventData: Record<string, unknown>): string[] | undefined {
  const folders = eventData.folders;
  if (!Array.isArray(folders) || folders.some((folder) => typeof folder !== "string" || folder.length === 0)) return undefined;
  return folders as string[];
}

/** The library this hook configures for a HexOS folder, by the folder's mount path in the guest; `Media` has none. */
export function libraryForFolder(folder: string): Library | undefined {
  const location = `/mnt/${folder.toLowerCase()}`;
  return LIBRARIES.find((library) => library.location === location);
}

/** The checkpoint id the platform reads per folder: completed means a scan was accepted, skipped means nothing to scan. */
export const mediaCheckpoint = (folder: string): string => `media:${folder}`;
/** Plex is expected up when the platform fires the event; three looks, not the install's twenty-four. */
export const RECOVERY_READY_ATTEMPTS = 3;

/**
 * The platform saw default media folders connected again after an outage
 * (`onMediaReconnected`, `ctx.eventData.folders`). A scan of each folder's
 * library makes Plex read it again: anything a scan during the outage marked
 * unavailable is available again, and anything added is indexed. Never while
 * a folder is disconnected — the platform fires only after the reconnect.
 * One checkpoint per folder, by id: completed means Plex accepted the scan,
 * skipped means there was nothing to scan (no library for the folder, no
 * such library on this server, or no server token because the sign-in was
 * not used); the platform reads the ids, never the text. A refused token or
 * a refused scan fails the run, so the folders not yet handled stay with the
 * platform.
 */
export async function onMediaReconnected(ctx: VMHookContext): Promise<void> {
  const folders = readReconnectedFolders(ctx.eventData);
  if (!folders || folders.length === 0) ctx.fail("The event named no folders", [{ label: "Event", value: ctx.event }]);
  await ctx.registerCheckpoints(folders.map((folder) => ({ id: mediaCheckpoint(folder), message: `Scan for ${folder}` })));
  const serverToken = await ctx.secrets.get(SERVER_TOKEN_SECRET);
  if (!serverToken) {
    for (const folder of folders) {
      await ctx.skipCheckpoint(mediaCheckpoint(folder), "Not signed in to Plex during setup; no server token, nothing to scan");
    }
    ctx.log("no server token: the sign-in setup did not run, so no library here is ours to scan");
    return;
  }
  const first = await ctx.waitForApp("/identity", { maxAttempts: RECOVERY_READY_ATTEMPTS, headers: JSON_ACCEPT });
  if (!readIdentity(first.text())) {
    ctx.fail("Plex answered, but not with its identity", [{ label: "Status", value: String(first.status) }]);
  }
  const listing = await ctx.fetch("/library/sections", { headers: withToken(serverToken) });
  if (listing.status === 401) ctx.fail("Plex refused the server token", [{ label: "Status", value: "401" }]);
  const sections = listing.status === 200 ? readSections(listing.text()) : undefined;
  if (!sections) ctx.fail("Plex did not list its libraries", [{ label: "Status", value: String(listing.status) }]);
  for (const folder of folders) {
    const library = libraryForFolder(folder);
    if (!library) {
      await ctx.skipCheckpoint(mediaCheckpoint(folder), `${folder} has no library; nothing to scan`);
      continue;
    }
    const section = sections.find((candidate) => candidate.locations.includes(library.location));
    if (!section) {
      await ctx.skipCheckpoint(mediaCheckpoint(folder), `No ${library.name} library at ${library.location} on this server`);
      continue;
    }
    const scan = await ctx.fetch(`/library/sections/${encodeURIComponent(section.key)}/refresh`, { headers: withToken(serverToken) });
    if (scan.status !== 200) {
      ctx.fail(`Plex refused the scan of ${library.name}`, [
        { label: "Status", value: String(scan.status) },
        { label: "Section", value: section.key },
      ]);
    }
    await ctx.emitCheckpoint(mediaCheckpoint(folder), `Scan requested for ${folder}`);
  }
}

export async function run(ctx: VMHookContext): Promise<void> {
  await runWith(ctx, (url, init) => fetch(url, { headers: init.headers, signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS) }));
}

export async function runWith(ctx: VMHookContext, plexTv: PlexTvFetch): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Confirming Plex answers" },
    { id: "claimed", message: "Claiming the server on your Plex account" },
    { id: "named", message: "Naming the server" },
    { id: "token", message: "Keeping the server's access token" },
    ...LIBRARIES.map((library) => ({ id: library.checkpointId, message: `Creating library: ${library.name}` })),
    { id: "scan", message: "Asking Plex to scan the libraries" },
  ]);

  const authToken = readAccountToken(ctx.getInput(SIGN_IN_INPUT));
  if (!authToken) ctx.fail("The Plex sign-in carried no token; sign in again and retry");

  // Reachability first, on the one path every Plex answers without a token.
  const first = await ctx.waitForApp("/identity", { maxAttempts: READY_ATTEMPTS, headers: JSON_ACCEPT });
  const identity = readIdentity(first.text());
  if (!identity) {
    ctx.fail("Plex answered, but not with its identity", [
      { label: "Path", value: "/identity" },
      { label: "Status", value: String(first.status) },
    ]);
  }
  ctx.log(`Plex ${identity.version ?? "(version unknown)"} answered; claimed=${identity.claimed}`);
  await ctx.emitCheckpoint("ready", `Plex answered at ${first.url}`);

  // How the server came to be claimed: before this run, by this run's acknowledged
  // claim, or reconciled — a refused claim after which the same server reports
  // itself claimed (an attempt may have landed without its answer reaching the
  // hook). The account's listing below decides ownership in every case.
  let claimedHow: "already" | "now" | "reconciled" = identity.claimed ? "already" : "now";
  if (identity.claimed) {
    ctx.log("Plex is already claimed; the account's listing decides whether it is the signed-in account's");
  } else {
    const claimToken = await fetchClaimToken(plexTv, authToken, ctx);
    const lastStatus = await claimServer(ctx, authToken, claimToken);
    const after = readIdentity((await ctx.fetch("/identity", { headers: JSON_ACCEPT })).text());
    if (!after || after.machineIdentifier !== identity.machineIdentifier) {
      ctx.fail("The server answering after the claim is not the one that was claimed", [
        { label: "Claimed", value: identity.machineIdentifier },
        { label: "Answering", value: after?.machineIdentifier ?? "(no identity)" },
      ]);
    }
    if (lastStatus !== 200) {
      if (!after.claimed) {
        ctx.fail("Plex did not accept the claim", [
          { label: "Endpoint", value: "POST /myplex/claim" },
          { label: "Last status", value: lastStatus === undefined ? "no answer" : String(lastStatus) },
        ]);
      }
      claimedHow = "reconciled";
      ctx.log(
        `the claim answered ${lastStatus === undefined ? "nothing" : lastStatus}, but the same server now reports itself claimed; ownership is decided by the account's listing`,
      );
    } else if (!after.claimed) {
      ctx.fail("Plex accepted the claim but still reports itself unclaimed", [
        { label: "Server", value: identity.machineIdentifier },
      ]);
    }
  }

  // Ownership is decided by plex.tv's listing before anything is written to a
  // server this hook did not just claim, and the same lookup carries the
  // server's own token. A failure here says whether a claim was made in this
  // run, because on a fresh server the claim has already changed the guest.
  const accessToken = await findOwnedServerToken(plexTv, authToken, identity.machineIdentifier, claimedHow, ctx);
  await ctx.emitCheckpoint(
    "claimed",
    claimedHow === "already"
      ? "Already claimed on your Plex account"
      : claimedHow === "now"
        ? "Claimed on your Plex account"
        : "Claimed on your Plex account (the claim was reconciled from the server, not acknowledged)",
  );

  const name = chooseServerName(ctx);
  const named = await ctx.fetch(`/:/prefs?FriendlyName=${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: withToken(authToken),
  });
  if (named.status !== 200) {
    ctx.fail("Plex refused the server name", [
      { label: "Name", value: name },
      { label: "Status", value: String(named.status) },
    ]);
  }
  const reported = readFriendlyName((await ctx.fetch("/", { headers: withToken(authToken) })).text());
  if (reported !== name) {
    ctx.fail("Plex did not take the server name", [
      { label: "Expected", value: name },
      { label: "Reported", value: reported ?? "(none)" },
    ]);
  }
  await ctx.emitCheckpoint("named", `Named ${name}`);

  await ctx.secrets.set(SERVER_TOKEN_SECRET, accessToken);
  const kept = await ctx.secrets.get(SERVER_TOKEN_SECRET);
  if (kept !== accessToken) {
    ctx.fail("The server's access token could not be read back from the platform's store");
  }
  await ctx.emitCheckpoint("token", "Kept the server's access token for HexOS");

  // Disable trash removal before creating a section: creation can trigger a scan.
  await disableTrashEmptying(ctx, authToken);
  const sections: PlexSection[] = [];
  for (const library of LIBRARIES) {
    const { section, created } = await ensureLibrary(ctx, authToken, library);
    sections.push(section);
    await ctx.emitCheckpoint(library.checkpointId, `${library.name} at ${library.location} (${created ? "created" : "already existed"})`);
  }
  for (const section of sections) {
    const scan = await ctx.fetch(`/library/sections/${encodeURIComponent(section.key)}/refresh`, { headers: withToken(authToken) });
    if (scan.status !== 200) {
      ctx.fail("Plex did not start the library scan", [
        { label: "Library", value: section.title },
        { label: "Status", value: String(scan.status) },
      ]);
    }
  }
  await ctx.emitCheckpoint("scan", "Scans requested for Movies, TV Shows, Music, Photos and Videos");
}

/** The sections Plex lists, once its library subsystem answers; fails after the declared attempts. */
async function listSections(ctx: VMHookContext, authToken: string): Promise<PlexSection[]> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= LIBRARY_ATTEMPTS; attempt++) {
    const response = await ctx.fetch("/library/sections", { headers: withToken(authToken) });
    lastStatus = response.status;
    const sections = response.status === 200 ? readSections(response.text()) : undefined;
    if (sections) return sections;
    ctx.log(`library attempt ${attempt}/${LIBRARY_ATTEMPTS}: sections answered ${response.status}`);
    if (attempt < LIBRARY_ATTEMPTS) await ctx.sleep(LIBRARY_RETRY_MS);
  }
  return ctx.fail("Plex's library subsystem did not answer", [
    { label: "Attempts", value: String(LIBRARY_ATTEMPTS) },
    { label: "Last status", value: lastStatus === undefined ? "no answer" : String(lastStatus) },
  ]);
}

/**
 * The library on the media mount: the existing section whose location is the
 * mount, or one created for it and then read back. Creation is verified by
 * listing, never trusted from the creation answer.
 */
async function ensureLibrary(ctx: VMHookContext, authToken: string, library: Library): Promise<{ section: PlexSection; created: boolean }> {
  const { name, type, agent, scanner, language, location } = library;
  const query = new URLSearchParams({ name, type, agent, scanner, language, location });
  for (let attempt = 1; attempt <= LIBRARY_ATTEMPTS; attempt++) {
    // Recheck after a wait: another setup may have created the library.
    const existing = (await listSections(ctx, authToken)).find((section) => section.locations.includes(library.location));
    if (existing) {
      ctx.log(`library "${existing.title}" already covers ${library.location}; leaving it alone`);
      return { section: existing, created: false };
    }
    const creation = await ctx.fetch(`/library/sections?${query.toString()}`, { method: "POST", headers: withToken(authToken) });
    // Only Plex's explicit startup refusal is safe to retry. A transport
    // exception may follow a successful write and must propagate unchanged.
    // Do not log the response body: it is untrusted and may carry secrets.
    if (creation.status === 400 && creation.text().includes("the server is still starting up. Please retry later")) {
      ctx.log(`library creation attempt ${attempt}/${LIBRARY_ATTEMPTS}: Plex is still starting up`);
      if (attempt < LIBRARY_ATTEMPTS) await ctx.sleep(LIBRARY_RETRY_MS);
      continue;
    }
    if (creation.status < 200 || creation.status >= 300) {
      return ctx.fail(`Plex refused to create a library at ${library.location}`, [
        { label: "Status", value: String(creation.status) },
        { label: "Next step", value: "Check Plex's library settings and media access, then run setup again" },
      ]);
    }
    const section = (await listSections(ctx, authToken)).find((entry) => entry.locations.includes(library.location));
    if (!section) {
      return ctx.fail("Plex accepted the library but does not list it", [{ label: "Location", value: library.location }]);
    }
    return { section, created: true };
  }
  return ctx.fail(`Plex is still starting up and could not create ${library.name}`, [
    { label: "Attempts", value: String(LIBRARY_ATTEMPTS) },
    { label: "Next step", value: "Allow Plex to finish starting, then run setup again" },
  ]);
}

/** Plex must not drop library items whose files are missing at a scan: an absent share is temporary, the records are not. */
async function disableTrashEmptying(ctx: VMHookContext, authToken: string): Promise<void> {
  const set = await ctx.fetch(`/:/prefs?${TRASH_PREFERENCE}=0`, { method: "PUT", headers: withToken(authToken) });
  if (set.status !== 200) {
    ctx.fail("Plex refused the trash-emptying setting", [{ label: "Status", value: String(set.status) }]);
  }
  const value = readPreference((await ctx.fetch("/:/prefs", { headers: withToken(authToken) })).text(), TRASH_PREFERENCE);
  if (readClaimed(value) !== false) {
    ctx.fail("Plex did not take the trash-emptying setting", [
      { label: "Preference", value: TRASH_PREFERENCE },
      { label: "Reported", value: value === undefined ? "(not listed)" : String(value) },
    ]);
  }
}

async function fetchClaimToken(plexTv: PlexTvFetch, authToken: string, ctx: VMHookContext): Promise<string> {
  let response: Awaited<ReturnType<PlexTvFetch>>;
  try {
    response = await plexTv(`${PLEX_TV}${CLAIM_TOKEN_PATH}`, { headers: plexTvHeaders(authToken) });
  } catch (error) {
    return ctx.fail("plex.tv could not be reached for a claim token", [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  const claimToken = response.status === 200 ? readClaimToken(await response.text()) : undefined;
  if (!claimToken) {
    return ctx.fail("plex.tv did not issue a claim token for the signed-in account", [
      { label: "Status", value: String(response.status) },
    ]);
  }
  return claimToken;
}

/** POSTs the claim, a few times if Plex is slow to take it; the last status seen, undefined when it never answered. */
async function claimServer(ctx: VMHookContext, authToken: string, claimToken: string): Promise<number | undefined> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
    try {
      const response = await ctx.fetch(`/myplex/claim?token=${encodeURIComponent(claimToken)}`, {
        method: "POST",
        headers: withToken(authToken),
        timeoutMs: 15000,
      });
      lastStatus = response.status;
      if (response.status === 200) return 200;
      ctx.log(`claim attempt ${attempt}/${CLAIM_ATTEMPTS} answered ${response.status}`);
    } catch (error) {
      // The claim token rides in the query string, and a transport error may
      // quote the URL it was asked for: the log gets the error's kind only.
      ctx.log(`claim attempt ${attempt}/${CLAIM_ATTEMPTS} failed: ${classifyGuestError(error)}`);
    }
    if (attempt < CLAIM_ATTEMPTS) await ctx.sleep(CLAIM_RETRY_MS);
  }
  return lastStatus;
}

/**
 * The server's access token from plex.tv's listing, once the listing shows
 * the server and shows it owned by the signed-in account. An unlisted server
 * is waited for, because a fresh claim takes a moment to publish; a listed
 * server the account does not own, or one listed without a token, fails at
 * once and before the name is written. Each failure states whether this run
 * claimed the server: on a server that was already claimed, nothing has been
 * written; on a fresh one, the claim has.
 */
async function findOwnedServerToken(
  plexTv: PlexTvFetch,
  authToken: string,
  machineIdentifier: string,
  claimedHow: "already" | "now" | "reconciled",
  ctx: VMHookContext,
): Promise<string> {
  const claimedContext = {
    label: "Claimed in this run",
    value: claimedHow === "now" ? "yes" : claimedHow === "reconciled" ? "reconciled from the server, not acknowledged" : "no",
  };
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= RESOURCES_ATTEMPTS; attempt++) {
    // Only the request is guarded: a decision made inside the guard would be
    // caught as a transport failure and retried instead of ending the hook.
    let listing: PlexListing | undefined;
    try {
      const response = await plexTv(`${PLEX_TV}${RESOURCES_PATH}`, { headers: plexTvHeaders(authToken) });
      lastStatus = response.status;
      if (response.status === 200) listing = readServerToken(await response.text(), machineIdentifier);
      else ctx.log(`resources attempt ${attempt}/${RESOURCES_ATTEMPTS} answered ${response.status}`);
    } catch (error) {
      ctx.log(`resources attempt ${attempt}/${RESOURCES_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (listing?.listed) {
      if (!listing.owned) {
        return ctx.fail("Plex is claimed on the signed-in account but not owned by it", [
          { label: "Server", value: machineIdentifier },
          claimedContext,
          { label: "Next step", value: "Sign in as the account that owns this server, then run setup again" },
        ]);
      }
      if (!listing.accessToken) {
        return ctx.fail("plex.tv lists this server without an access token", [{ label: "Server", value: machineIdentifier }, claimedContext]);
      }
      return listing.accessToken;
    }
    if (listing) ctx.log(`resources attempt ${attempt}/${RESOURCES_ATTEMPTS}: server not listed yet`);
    if (attempt < RESOURCES_ATTEMPTS) await ctx.sleep(RESOURCES_RETRY_MS);
  }
  return ctx.fail("plex.tv does not list this server on the signed-in account", [
    { label: "Server", value: machineIdentifier },
    claimedContext,
    { label: "Attempts", value: String(RESOURCES_ATTEMPTS) },
    { label: "Last status", value: lastStatus === undefined ? "no answer" : String(lastStatus) },
    { label: "Next step", value: "If the server was claimed before this install, sign in as the account that owns it" },
  ]);
}
