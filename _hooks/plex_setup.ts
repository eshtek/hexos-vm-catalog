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
 * proof that it is unclaimed, and stops the hook too. Libraries are not
 * created here: the appliance mounts no media of its own, so a library would
 * only point at an empty folder.
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

export async function run(ctx: VMHookContext): Promise<void> {
  await runWith(ctx, (url, init) => fetch(url, { headers: init.headers, signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS) }));
}

export async function runWith(ctx: VMHookContext, plexTv: PlexTvFetch): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Confirming Plex answers" },
    { id: "claimed", message: "Claiming the server on your Plex account" },
    { id: "named", message: "Naming the server" },
    { id: "token", message: "Keeping the server's access token" },
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

  if (identity.claimed) {
    ctx.log("Plex is already claimed; the account's listing decides whether it is the signed-in account's");
  } else {
    const claimToken = await fetchClaimToken(plexTv, authToken, ctx);
    const lastStatus = await claimServer(ctx, authToken, claimToken);
    if (lastStatus !== 200) {
      ctx.fail("Plex did not accept the claim", [
        { label: "Endpoint", value: "POST /myplex/claim" },
        { label: "Last status", value: lastStatus === undefined ? "no answer" : String(lastStatus) },
      ]);
    }
    const after = readIdentity((await ctx.fetch("/identity", { headers: JSON_ACCEPT })).text());
    if (!after || after.machineIdentifier !== identity.machineIdentifier) {
      ctx.fail("The server answering after the claim is not the one that was claimed", [
        { label: "Claimed", value: identity.machineIdentifier },
        { label: "Answering", value: after?.machineIdentifier ?? "(no identity)" },
      ]);
    }
    if (!after.claimed) {
      ctx.fail("Plex accepted the claim but still reports itself unclaimed", [
        { label: "Server", value: identity.machineIdentifier },
      ]);
    }
  }

  // Ownership is decided by plex.tv's listing before anything is written to a
  // server this hook did not just claim, and the same lookup carries the
  // server's own token. A failure here says whether a claim was made in this
  // run, because on a fresh server the claim has already changed the guest.
  const accessToken = await findOwnedServerToken(plexTv, authToken, identity.machineIdentifier, !identity.claimed, ctx);
  await ctx.emitCheckpoint("claimed", identity.claimed ? "Already claimed on your Plex account" : "Claimed on your Plex account");

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
  claimedInThisRun: boolean,
  ctx: VMHookContext,
): Promise<string> {
  const claimedContext = { label: "Claimed in this run", value: claimedInThisRun ? "yes" : "no" };
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
