import type { VMHookContext } from "../_lib/hook_context";

/**
 * Plex Media Server appliance, after the guest is ready: claims the new
 * server on the Plex account the user signed into, names it, and keeps the
 * server's own access token for the platform.
 *
 * What it changes on the guest, and nothing else: the claim (only on a server
 * whose identity says it is not yet claimed), the friendly name (only on a
 * server plex.tv lists as owned by the signed-in account), the server
 * preferences it declares, and the five libraries below. An existing claim
 * is never touched: a server already claimed is named and its token kept if
 * the account owns it, and the hook stops before any write if the account
 * does not own it or plex.tv does not list it — a shared server, or someone
 * else's. An identity that does not say whether the server is claimed is not
 * proof that it is unclaimed, and stops the hook too. The five libraries use
 * the appliance's default HexOS mounts, with trash emptying disabled and
 * scans requested.
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
/** Per-request ceiling on the guest's claim endpoint, which talks to plex.tv on the server's behalf. */
const CLAIM_TIMEOUT_MS = 15000;
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
/** A beat before each configuration step's check lands, and one at the end, so the deck's checklist reads step by step instead of flashing to done. */
const CHECKPOINT_PACE_MS = 2000;
/** Plex's preference that removes library items whose files went missing at the next scan; off, so an absent share loses nothing. */
const TRASH_PREFERENCE = "autoEmptyTrash";
/**
 * What the app's own hook writes after a claim, and the scan schedule the
 * folders need. Plex cannot watch a CIFS or virtiofs mount for changes (its
 * automatic update rests on filesystem notifications neither delivers for
 * changes made on the NAS), so it scans on a schedule: every library once an hour, which
 * reads every library folder on the NAS once an hour. The EULA accepted opens
 * the web UI on the server instead of its setup wizard; publishing the server
 * on the account lets Plex apps find it (remote access may still need the
 * user's router). Written only once trash emptying is confirmed off: a
 * scheduled scan during a share outage must mark items unavailable, never
 * remove them. A rerun of setup applies these again, over any later change.
 */
const SERVER_PREFERENCES: Record<string, string> = {
  AcceptedEULA: "1",
  PublishServerOnPlexOnlineKey: "1",
  ScheduledLibraryUpdatesEnabled: "1",
  ScheduledLibraryUpdateInterval: "3600",
};

export interface PlexSection {
  key: string;
  title: string;
  type: string;
  locations: string[];
}

export interface PlexIdentity {
  machineIdentifier: string;
  claimed: boolean;
  version?: string;
}

/** What plex.tv's resources listing says about one server, by its machine identifier; undefined when the document is not the listing. */
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

/**
 * A Plex boolean in the representations it uses (a JSON boolean, a 0/1, or
 * the strings of either): the claimed flag, and the on/off preferences read
 * back from `/:/prefs`. Anything else is not a state.
 */
export function readClaimed(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

/**
 * Plex's document envelope, when the answer is the JSON the hook asked for. The
 * hook reads JSON only: every request carries `Accept: application/json`, so
 * an answer in any other form, XML included, is not an answer to the question
 * put and reads as no document. One parser, the runtime's, decides what is
 * well-formed; nothing here searches text for what it hopes to find.
 */
function jsonContainer(text: string): Record<string, unknown> | undefined {
  const parsed = parseJson(text) as { MediaContainer?: unknown } | undefined;
  const container = parsed?.MediaContainer;
  return container !== null && typeof container === "object" && !Array.isArray(container) ? (container as Record<string, unknown>) : undefined;
}

/**
 * The server's identity as `/identity` reports it to a JSON request. A
 * document that does not carry both the machine identifier and an explicit
 * claim state is not Plex's identity and reads as undefined rather than as a
 * guess: a missing claim state is not evidence that the server is unclaimed.
 */
export function readIdentity(text: string): PlexIdentity | undefined {
  const container = jsonContainer(text);
  if (!container) return undefined;
  const machineIdentifier = container.machineIdentifier;
  const claimed = readClaimed(container.claimed);
  if (typeof machineIdentifier !== "string" || machineIdentifier.length === 0 || claimed === undefined) return undefined;
  return { machineIdentifier, claimed, version: typeof container.version === "string" ? container.version : undefined };
}

/** The friendly name the server's root document reports to a JSON request. */
export function readFriendlyName(text: string): string | undefined {
  const container = jsonContainer(text);
  const name = container?.friendlyName;
  return typeof name === "string" ? name : undefined;
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
 * only an explicit `owned: true` counts), and its access token. A document
 * that is not the listing (not an array of entries), or one that lists the
 * identifier twice, reads as undefined rather than as "not listed yet": the
 * latter is retried while a server registers, the former never comes right.
 */
export function readServerToken(text: string, machineIdentifier: string): PlexListing | undefined {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "object" && entry !== null)) return undefined;
  const matching = parsed.filter((entry) => (entry as { clientIdentifier?: unknown }).clientIdentifier === machineIdentifier) as Array<{
    owned?: unknown;
    accessToken?: unknown;
  }>;
  if (matching.length > 1) return undefined;
  const server = matching[0];
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
 * server with no libraries. A section without `Location` has none; a
 * `Location` that is present but not a list of `{ path }` entries is not that
 * document either, since an empty answer here would read as "nothing covers
 * this folder" and permit a creation.
 */
export function readSections(text: string): PlexSection[] | undefined {
  const parsed = parseJson(text) as { MediaContainer?: { Directory?: unknown } } | undefined;
  const container = parsed?.MediaContainer;
  if (!container || typeof container !== "object" || Array.isArray(container)) return undefined;
  const directories = container.Directory;
  if (directories === undefined) return [];
  if (!Array.isArray(directories)) return undefined;
  const sections: PlexSection[] = [];
  for (const entry of directories) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { key, title, type, Location } = entry as { key?: unknown; title?: unknown; type?: unknown; Location?: unknown };
    if (typeof key !== "string" || typeof title !== "string" || typeof type !== "string") return undefined;
    if (Location !== undefined && !Array.isArray(Location)) return undefined;
    const locations: string[] = [];
    for (const location of Location ?? []) {
      const path = typeof location === "object" && location !== null ? (location as { path?: unknown }).path : undefined;
      if (typeof path !== "string") return undefined;
      locations.push(path);
    }
    sections.push({ key, title, type, locations });
  }
  return sections;
}

/**
 * One preference's value from `/:/prefs` as JSON (`MediaContainer.Setting[]`),
 * or undefined when it is not listed exactly once: a setting listed twice is
 * a contradiction, not a value, and a reader that took the first copy would
 * let the order of a malformed document decide whether a scan is safe.
 */
export function readPreference(text: string, id: string): unknown {
  const parsed = parseJson(text) as { MediaContainer?: { Setting?: unknown } } | undefined;
  const settings = parsed?.MediaContainer?.Setting;
  if (!Array.isArray(settings)) return undefined;
  const matching = settings.filter((entry) => typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === id);
  return matching.length === 1 ? (matching[0] as { value?: unknown }).value : undefined;
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
  // No scan while automatic trash emptying is on, or while its state cannot
  // be read: Plex empties the trash after a scan, and a folder that was gone
  // may still be gone for a library this scan would touch. Setup turns the
  // setting off, but a setup that failed after keeping the token, or a change
  // made in Plex since, would leave it on.
  const preferences = await ctx.fetch("/:/prefs", { headers: withToken(serverToken) });
  if (preferences.status === 401) ctx.fail("Plex refused the server token", [{ label: "Status", value: "401" }]);
  const trash = preferences.status === 200 ? readClaimed(readPreference(preferences.text(), TRASH_PREFERENCE)) : undefined;
  if (trash !== false) {
    ctx.fail("Plex's automatic trash emptying is not confirmed off; no scan requested", [
      { label: "Preference", value: TRASH_PREFERENCE },
      { label: "Reported", value: trash === undefined ? "(not readable)" : "on" },
      { label: "Next step", value: "Run setup again, which turns it off, or turn it off in Plex's settings" },
    ]);
  }
  const listing = await ctx.fetch("/library/sections", { headers: withToken(serverToken) });
  if (listing.status === 401) ctx.fail("Plex refused the server token", [{ label: "Status", value: "401" }]);
  const sections = listing.status === 200 ? readSections(listing.text()) : undefined;
  if (!sections) ctx.fail("Plex did not list its libraries", [{ label: "Status", value: String(listing.status) }]);
  // Each folder is its own scan: one library Plex refuses does not keep the
  // folders after it from being asked, or a library that always refuses would
  // starve the rest on every retry. The run still fails, naming every refusal,
  // and a refused folder's checkpoint stays absent, so the platform offers it
  // again after its window.
  const refused: Array<{ name: string; status: string; section: string }> = [];
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
    // A request that does not reach Plex is a refusal of this library like any
    // other: it is recorded and the next library is still asked. Once the
    // attempt itself has ended, every request fails the same way and the run
    // ends at the failure below.
    let scan: { status: number } | undefined;
    try {
      scan = await ctx.fetch(`/library/sections/${encodeURIComponent(section.key)}/refresh`, { headers: withToken(serverToken) });
    } catch (error) {
      refused.push({ name: library.name, status: `unreachable: ${error instanceof Error ? error.message : String(error)}`, section: section.key });
      continue;
    }
    if (scan.status !== 200) {
      refused.push({ name: library.name, status: String(scan.status), section: section.key });
      continue;
    }
    await ctx.emitCheckpoint(mediaCheckpoint(folder), `Scan requested for ${folder}`);
  }
  if (refused.length > 0) {
    ctx.fail(
      `Plex refused the scan of ${refused.map((entry) => entry.name).join(", ")}`,
      refused.flatMap((entry) => [
        { label: "Status", value: entry.status },
        { label: "Section", value: entry.section },
      ]),
    );
  }
}

export async function run(ctx: VMHookContext): Promise<void> {
  await runWith(ctx, (url, init) => fetch(url, { headers: init.headers, signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS) }));
}

export async function runWith(ctx: VMHookContext, plexTv: PlexTvFetch): Promise<void> {
  // The steps the deck lists, the shape of the Plex app's: the server answers,
  // the claim, the preferences (the name and the kept token are part of them),
  // one library each. The scans are logged, not a step of their own.
  await ctx.registerCheckpoints([
    { id: "ready", message: "Confirming Plex answers" },
    { id: "claimed", message: "Claiming the server on your Plex account" },
    { id: "preferences", message: "Configuring preferences" },
    ...LIBRARIES.map((library) => ({ id: library.checkpointId, message: `Creating library: ${library.name}` })),
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
        : "Claimed on your Plex account (confirmed from the server)",
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
  ctx.log(`named ${name}`);

  // Trash emptying off before anything can scan: creating a section triggers a
  // scan, and the schedule set next scans on its own. The server token is kept
  // only after that, so a setup that fails here leaves the recovery nothing to
  // scan with (it checks the setting again on every run regardless).
  await disableTrashEmptying(ctx, authToken);
  await ctx.secrets.set(SERVER_TOKEN_SECRET, accessToken);
  const kept = await ctx.secrets.get(SERVER_TOKEN_SECRET);
  if (kept !== accessToken) {
    ctx.fail("The server's access token could not be read back from the platform's store");
  }
  ctx.log("kept the server's access token for HexOS");
  await applyServerPreferences(ctx, authToken);
  await ctx.sleep(CHECKPOINT_PACE_MS);
  await ctx.emitCheckpoint("preferences", `Named ${name}; EULA accepted, published on your Plex account, libraries scanned hourly`);
  const sections: PlexSection[] = [];
  for (const library of LIBRARIES) {
    const { section, created } = await ensureLibrary(ctx, authToken, library);
    sections.push(section);
    await ctx.sleep(CHECKPOINT_PACE_MS);
    await ctx.emitCheckpoint(library.checkpointId, `${library.name} at ${library.location} (${created ? "created" : "already existed"})`);
  }
  // Every library is asked for its scan before the run judges the answers, as
  // the recovery does: one refused or unreachable scan neither stops the next
  // library's request nor hides behind it, and the failure names them all.
  const refused: Array<{ name: string; status: string }> = [];
  for (const section of sections) {
    let scan: { status: number } | undefined;
    try {
      scan = await ctx.fetch(`/library/sections/${encodeURIComponent(section.key)}/refresh`, { headers: withToken(authToken) });
    } catch (error) {
      refused.push({ name: section.title, status: `unreachable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (scan.status !== 200) refused.push({ name: section.title, status: String(scan.status) });
  }
  if (refused.length > 0) {
    ctx.fail(
      "Plex did not start every library scan",
      refused.map((entry) => ({ label: entry.name, value: entry.status })),
    );
  }
  ctx.log("scans requested for Movies, TV Shows, Music, Photos and Videos");
  await ctx.sleep(CHECKPOINT_PACE_MS);
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

/** The server preferences, written in one request and read back one by one. */
async function applyServerPreferences(ctx: VMHookContext, authToken: string): Promise<void> {
  const set = await ctx.fetch(`/:/prefs?${new URLSearchParams(SERVER_PREFERENCES).toString()}`, {
    method: "PUT",
    headers: withToken(authToken),
  });
  if (set.status !== 200) {
    ctx.fail("Plex refused the server preferences", [{ label: "Status", value: String(set.status) }]);
  }
  const listing = (await ctx.fetch("/:/prefs", { headers: withToken(authToken) })).text();
  for (const [id, expected] of Object.entries(SERVER_PREFERENCES)) {
    const value = readPreference(listing, id);
    const taken = expected === "1" ? readClaimed(value) === true : String(value) === expected;
    if (!taken) {
      ctx.fail("Plex did not take a server preference", [
        { label: "Preference", value: id },
        { label: "Expected", value: expected },
        { label: "Reported", value: value === undefined ? "(not listed)" : String(value) },
      ]);
    }
  }
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
        timeoutMs: CLAIM_TIMEOUT_MS,
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
    let answered = false;
    try {
      const response = await plexTv(`${PLEX_TV}${RESOURCES_PATH}`, { headers: plexTvHeaders(authToken) });
      lastStatus = response.status;
      if (response.status === 200) {
        answered = true;
        listing = readServerToken(await response.text(), machineIdentifier);
      } else ctx.log(`resources attempt ${attempt}/${RESOURCES_ATTEMPTS} answered ${response.status}`);
    } catch (error) {
      ctx.log(`resources attempt ${attempt}/${RESOURCES_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // An answer that is not the listing never becomes one: fail now, by name,
    // rather than retrying it as "not listed yet" for two minutes.
    if (answered && listing === undefined) {
      return ctx.fail("plex.tv answered, but not with its resources listing", [{ label: "Server", value: machineIdentifier }, claimedContext]);
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
