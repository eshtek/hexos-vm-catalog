import { describe, expect, test } from "bun:test";
import type { VMHookContext, VMHookFetchInit, VMHookResponse, WaitForAppOptions } from "../_lib/hook_context";
import {
  CLAIM_ATTEMPTS,
  LIBRARY_ATTEMPTS,
  type PlexTvFetch,
  RESOURCES_ATTEMPTS,
  SERVER_TOKEN_SECRET,
  classifyGuestError,
  decodeXmlAttribute,
  readAccountToken,
  readClaimed,
  readFriendlyName,
  readIdentity,
  readPreference,
  readSections,
  readServerToken,
  runWith, onMediaReconnected, readReconnectedFolders, libraryForFolder } from "./plex_setup";

// The hook's contract as these tests pin it: it confirms Plex answers, claims a
// server whose identity says it is unclaimed (and only that), writes nothing
// to a server that answers already claimed unless plex.tv lists it as owned by
// the signed-in account (on a fresh server the claim precedes that lookup, and
// a failure afterwards says so), names an owned server and keeps its own
// token, creates the five app-compatible libraries if their paths are not covered, turns
// Plex's trash emptying off, asks for a scan, verifies each write against what
// the guest then reports, and keeps tokens out of what it logs and records.
// The fakes are a scripted guest and a scripted plex.tv: they establish the
// hook's behaviour for the answers scripted here, not how a real Plex or
// plex.tv answers a shared or Home-user token, and not the platform's
// identity-bound secret store.

const ACCOUNT_TOKEN = "acct-token-1";
const CLAIM_TOKEN = "claim-token-1";
const SERVER_TOKEN = "server-token-1";
const MID = "mid-a";

function response(payload: unknown, status = 200, url = "http://192.0.2.240:32400/identity"): VMHookResponse {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    status,
    headers: {},
    body: new TextEncoder().encode(text),
    text: () => text,
    json: () => JSON.parse(text),
    url,
    hops: 0,
  };
}

const identity = (claimed: boolean, machineIdentifier = MID) =>
  response({ MediaContainer: { size: 0, apiVersion: "1.2.3", claimed, machineIdentifier, version: "1.43.4.10903-e5521bd8c" } });
const root = (friendlyName: string) => response({ MediaContainer: { size: 24, friendlyName, machineIdentifier: MID } });

type Answer = VMHookResponse | Error;
/** One answer, or a sequence consumed in order (the last one repeats). */
type Answers = Answer | Answer[];

interface Recorded {
  registered: string[];
  emitted: Array<{ id: string; message?: string }>;
  skipped: string[];
  waits: Array<{ path: string; opts?: WaitForAppOptions }>;
  requests: Array<{ method: string; path: string; headers: Record<string, string> }>;
  plexTv: Array<{ url: string; headers: Record<string, string> }>;
  sleeps: number[];
  logs: string[];
  secrets: Record<string, string>;
  secretWrites: number;
  failed?: { message: string; context?: Array<{ label: string; value: string }> };
}

function next(answers: Answers | undefined, key: string): Answer {
  if (answers === undefined) throw new Error(`unexpected request: ${key}`);
  if (!Array.isArray(answers)) return answers;
  if (answers.length === 0) throw new Error(`no answers left for ${key}`);
  return answers.length === 1 ? answers[0] : (answers.shift() as Answer);
}

function fakeContext(opts: {
  guest: Record<string, Answers>;
  inputs?: Record<string, unknown>;
  vmName?: string;
  readBack?: (key: string, stored: Record<string, string>) => string | undefined;
  /** The event this run is fired for; setup by default. */
  event?: VMHookContext["event"];
  eventData?: Record<string, unknown>;
  /** Secrets the instance already holds (a server token kept by an earlier setup). */
  secrets?: Record<string, string>;
}): { ctx: VMHookContext; recorded: Recorded } {
  const recorded: Recorded = {
    registered: [],
    emitted: [],
    skipped: [],
    waits: [],
    requests: [],
    plexTv: [],
    sleeps: [],
    logs: [],
    secrets: { ...(opts.secrets ?? {}) },
    secretWrites: 0,
  };
  const inputs = opts.inputs ?? { plex_login: { authToken: ACCOUNT_TOKEN } };
  const answer = (method: string, path: string): VMHookResponse => {
    const key = `${method} ${path}`;
    const chosen = next(opts.guest[key], key);
    if (chosen instanceof Error) throw chosen;
    return chosen;
  };
  const ctx = {
    resourceType: "vm",
    resourceId: "instance-a",
    vm: { instanceId: "instance-a", vmUuid: "uuid-a", name: opts.vmName ?? "Plex_Test3", blueprintId: "plex-server" },
    event: opts.event ?? "onAfterReady",
    eventData: opts.eventData ?? {},
    host: "192.0.2.240",
    port: 32400,
    baseUrl: "http://192.0.2.240:32400",
    inputs,
    mounts: [],
    secrets: {
      get: async (key: string) => (opts.readBack ? opts.readBack(key, recorded.secrets) : recorded.secrets[key]),
      set: async (key: string, value: string) => {
        recorded.secretWrites++;
        recorded.secrets[key] = value;
      },
      delete: async () => {
        recorded.secretWrites++;
      },
      list: async () => ({ ...recorded.secrets }),
    },
    fetch: async (path: string, init?: VMHookFetchInit) => {
      const method = init?.method ?? "GET";
      recorded.requests.push({ method, path, headers: init?.headers ?? {} });
      return answer(method, path);
    },
    getInstalledAppUrl: async () => null,
    getInput: (id: string) => {
      const value = inputs[id];
      if (value === undefined) throw new Error(`Missing required input: ${id}`);
      return value;
    },
    log: (message: string) => {
      recorded.logs.push(message);
    },
    sleep: async (ms: number) => {
      recorded.sleeps.push(ms);
    },
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      recorded.failed = { message, context };
      throw new Error(message);
    },
    registerCheckpoints: async (checkpoints: Array<{ id: string; message: string }>) => {
      recorded.registered.push(...checkpoints.map((cp) => cp.id));
    },
    emitCheckpoint: async (id: string, message?: string) => {
      recorded.emitted.push({ id, message });
    },
    updateCheckpointMessage: async () => {},
    setProgress: async () => {},
    skipCheckpoint: async (id: string) => {
      recorded.skipped.push(id);
    },
    getFailedAtCheckpoint: () => undefined,
    awaitCheckpointRetry: async () => "skip" as const,
    waitForApp: async (path: string, waitOpts?: WaitForAppOptions) => {
      recorded.waits.push({ path, opts: waitOpts });
      return answer("GET", path);
    },
  } as unknown as VMHookContext;
  return { ctx, recorded };
}

const CLAIM_URL = "https://plex.tv/api/claim/token.json";
const RESOURCES_URL = "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1";

function fakePlexTv(recorded: Recorded, answers: Record<string, Answers>): PlexTvFetch {
  return async (url, init) => {
    recorded.plexTv.push({ url, headers: init.headers });
    const chosen = next(answers[url], url);
    if (chosen instanceof Error) throw chosen;
    return { status: chosen.status, text: async () => chosen.text() };
  };
}

const claimTokenAnswer = response({ token: CLAIM_TOKEN });
/** The account's listing: someone else's shared server, then ours, owned, with a token that differs from the account's. */
const resourcesAnswer = response([
  { name: "Someone else's", clientIdentifier: "mid-other", provides: "server", owned: false, accessToken: "not-ours" },
  { name: "ubuntu", clientIdentifier: MID, provides: "server", owned: true, accessToken: SERVER_TOKEN },
]);

/**
 * What the run wrote where a person or a log could read it: log lines,
 * checkpoint messages, the failure and every request path except the claim's
 * own, whose query string is where Plex reads the claim token.
 */
function recordedSurfaces(recorded: Recorded): string {
  return JSON.stringify({
    logs: recorded.logs,
    emitted: recorded.emitted,
    failed: recorded.failed,
    requestPaths: recorded.requests.map((request) => request.path).filter((path) => !path.startsWith("/myplex/claim?")),
  });
}

const CLAIM_PATH = `/myplex/claim?token=${CLAIM_TOKEN}`;

// ── The library stage's answers ─────────────────────────────────────────────

const MEDIA_PATH = "/mnt/movies";
const SECTION_KEY = "7";
// Independent expectations copied from the app contract, not the VM implementation.
const expectedLibraries = [
  { name: "Movies", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie", language: "en-US", location: "/mnt/movies", checkpointId: "lib_movies" },
  { name: "TV Shows", type: "show", agent: "tv.plex.agents.series", scanner: "Plex TV Series", language: "en-US", location: "/mnt/shows", checkpointId: "lib_tv" },
  { name: "Music", type: "artist", agent: "tv.plex.agents.music", scanner: "Plex Music", language: "en-US", location: "/mnt/music", checkpointId: "lib_music" },
  { name: "Photos", type: "photo", agent: "com.plexapp.agents.none", scanner: "Plex Photo Scanner", language: "xn", location: "/mnt/photos", checkpointId: "lib_photos" },
  { name: "Videos", type: "movie", agent: "com.plexapp.agents.none", scanner: "Plex Video Files Scanner", language: "xn", location: "/mnt/videos", checkpointId: "lib_videos" },
];
const createPaths = expectedLibraries.map(({ checkpointId: _, ...query }) => `/library/sections?${new URLSearchParams(query)}`);
const sectionEntries = expectedLibraries.map((lib, i) => ({ key: String(7 + i), type: lib.type, title: lib.name, Location: [{ path: lib.location }] }));
const sectionsCount = (n: number) => response({ MediaContainer: { size: n, Directory: sectionEntries.slice(0, n) } });
const sectionsAll = () => sectionsCount(5);
const CREATE_PATH = createPaths[0];
const TRASH_OFF_PATH = "/:/prefs?autoEmptyTrash=0";
const PREFERENCES_PATH = "/:/prefs?AcceptedEULA=1&PublishServerOnPlexOnlineKey=1&ScheduledLibraryUpdatesEnabled=1&ScheduledLibraryUpdateInterval=3600";
/** The listing Plex answers once the server preferences are taken. */
const SERVER_PREFERENCES_TAKEN = { AcceptedEULA: true, PublishServerOnPlexOnlineKey: true, ScheduledLibraryUpdatesEnabled: true, ScheduledLibraryUpdateInterval: 3600 };
const REFRESH_PATH = `/library/sections/${SECTION_KEY}/refresh`;

const sectionsNone = () => response({ MediaContainer: { size: 0 } });
const sectionsMedia = () =>
  response({
    MediaContainer: {
      size: 1,
      Directory: [{ key: SECTION_KEY, type: "movie", title: "Movies", refreshing: false, Location: [{ id: 3, path: MEDIA_PATH }] }],
    },
  });
const sectionsOther = () =>
  response({
    MediaContainer: {
      size: 1,
      Directory: [{ key: "2", type: "movie", title: "Movies", refreshing: false, Location: [{ id: 1, path: "/data/movies" }] }],
    },
  });
const prefs = (values: Record<string, unknown>) =>
  response({ MediaContainer: { size: Object.keys(values).length, Setting: Object.entries(values).map(([id, value]) => ({ id, type: typeof value === "boolean" ? "bool" : "int", value })) } });
const prefsTrash = (value: unknown) => prefs({ ...SERVER_PREFERENCES_TAKEN, autoEmptyTrash: value });

/** The guest's answers for the library stage; fresh objects each call because sequences are consumed. */
function libraryAnswers(opts: { existing?: boolean } = {}): Record<string, Answers> {
  return {
    "GET /library/sections": opts.existing ? sectionsAll() : expectedLibraries.flatMap((_, i) => [sectionsCount(i), sectionsCount(i + 1)]),
    ...Object.fromEntries(createPaths.map((path) => [`POST ${path}`, response("", 201)])),
    [`PUT ${PREFERENCES_PATH}`]: response(""),
    [`PUT ${TRASH_OFF_PATH}`]: response(""),
    "GET /:/prefs": prefsTrash(false),
    ...Object.fromEntries(sectionEntries.map((section) => [`GET /library/sections/${section.key}/refresh`, response("")])),
  };
}

const LIBRARY_REQUESTS = [
  `PUT ${TRASH_OFF_PATH}`, "GET /:/prefs",
  `PUT ${PREFERENCES_PATH}`, "GET /:/prefs",
  ...createPaths.flatMap((path) => ["GET /library/sections", `POST ${path}`, "GET /library/sections"]),
  ...sectionEntries.map((section) => `GET /library/sections/${section.key}/refresh`),
];

/** A server that answers claimed, listed on the account as owned, with no library yet; the shape of a rerun on a server this hook set up. */
const ownedClaimedGuest = (): Record<string, Answers> => ({
  "GET /identity": identity(true),
  "PUT /:/prefs?FriendlyName=Plex_Test3": response(""),
  "GET /": root("Plex_Test3"),
  ...libraryAnswers(),
});

const ALL_CHECKPOINTS = ["ready", "claimed", "preferences", ...expectedLibraries.map((lib) => lib.checkpointId)];

describe("run: a fresh server", () => {
  test("claims it, names it after the VM, keeps the server's own token rather than the account's, creates all five libraries after disabling trash emptying and asks for their scans", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: response('<MyPlex signInState="ok"/>'),
        "PUT /:/prefs?FriendlyName=Plex_Test3": response(""),
        "GET /": root("Plex_Test3"),
        ...libraryAnswers(),
      },
    });
    const plexTv = fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: resourcesAnswer });
    await runWith(ctx, plexTv);

    expect(recorded.registered).toEqual(ALL_CHECKPOINTS);
    expect(recorded.waits).toEqual([{ path: "/identity", opts: { maxAttempts: 24, headers: { Accept: "application/json" } } }]);
    expect(recorded.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${CLAIM_PATH}`,
      "GET /identity",
      "PUT /:/prefs?FriendlyName=Plex_Test3",
      "GET /",
      ...LIBRARY_REQUESTS,
    ]);
    // The account token authorises everything after the claim as a header;
    // the identity re-read after the claim carries none; no path carries it.
    const authorised = recorded.requests.filter((request) => request.path !== "/identity");
    expect(authorised).toHaveLength(3 + LIBRARY_REQUESTS.length);
    // Trash emptying is confirmed off before the scan schedule is written: the preferences go in one request after it.
    expect(recorded.requests.map((request) => request.path).indexOf(TRASH_OFF_PATH)).toBeLessThan(recorded.requests.map((request) => request.path).indexOf(PREFERENCES_PATH));
    for (const request of authorised) expect(request.headers["X-Plex-Token"]).toBe(ACCOUNT_TOKEN);
    expect(recorded.requests.find((request) => request.path === "/identity")?.headers).toEqual({ Accept: "application/json" });
    for (const request of recorded.requests) expect(request.path).not.toContain(ACCOUNT_TOKEN);
    // plex.tv: the claim token first, then the listing, before anything is named.
    expect(recorded.plexTv.map((call) => call.url)).toEqual([CLAIM_URL, RESOURCES_URL]);
    for (const call of recorded.plexTv) {
      expect(call.headers["X-Plex-Token"]).toBe(ACCOUNT_TOKEN);
      expect(call.headers["X-Plex-Client-Identifier"]).toBe("hexos-platform");
    }
    expect(recorded.secretWrites).toBe(1);
    expect(recorded.secrets).toEqual({ [SERVER_TOKEN_SECRET]: SERVER_TOKEN });
    expect(recorded.emitted).toEqual([
      { id: "ready", message: "Plex answered at http://192.0.2.240:32400/identity" },
      { id: "claimed", message: "Claimed on your Plex account" },
      { id: "preferences", message: "Named Plex_Test3; EULA accepted, published on your Plex account, libraries scanned hourly" },
      ...expectedLibraries.map((lib) => ({ id: lib.checkpointId, message: `${lib.name} at ${lib.location} (created)` })),
    ]);
    expect(recorded.skipped).toEqual([]);
    expect(recorded.failed).toBeUndefined();
    // A two-second beat before the preferences check, before each library's, and one at the end.
    expect(recorded.sleeps.filter((ms) => ms === 2000)).toHaveLength(7);
  });

  test("keeps every token out of its logs, its checkpoints and every request path but the claim's own query", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: response(""),
        "PUT /:/prefs?FriendlyName=Plex_Test3": response(""),
        "GET /": root("Plex_Test3"),
        ...libraryAnswers(),
      },
    });
    await runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.logs.length).toBeGreaterThan(0);
    for (const secret of [ACCOUNT_TOKEN, CLAIM_TOKEN, SERVER_TOKEN, "not-ours"]) {
      expect(recordedSurfaces(recorded)).not.toContain(secret);
    }
  });

  test("uses the answered server name over the VM's, and accepts a bare token as the sign-in", async () => {
    const { ctx, recorded } = fakeContext({
      inputs: { plex_login: ACCOUNT_TOKEN, server_name: " Family Plex " },
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: response(""),
        "PUT /:/prefs?FriendlyName=Family%20Plex": response(""),
        "GET /": root("Family Plex"),
        ...libraryAnswers(),
      },
    });
    await runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.requests.map((request) => request.path)).toContain("/:/prefs?FriendlyName=Family%20Plex");
    expect(recorded.emitted.find((cp) => cp.id === "preferences")?.message).toContain("Named Family Plex;");
    expect(recorded.secrets[SERVER_TOKEN_SECRET]).toBe(SERVER_TOKEN);
  });

  test("a blank server name answer falls back to the VM's name", async () => {
    const { ctx, recorded } = fakeContext({
      inputs: { plex_login: { authToken: ACCOUNT_TOKEN }, server_name: "" },
      vmName: "Media_Box",
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: response(""),
        "PUT /:/prefs?FriendlyName=Media_Box": response(""),
        "GET /": root("Media_Box"),
        ...libraryAnswers(),
      },
    });
    await runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.emitted.find((cp) => cp.id === "preferences")?.message).toContain("Named Media_Box;");
  });
});

describe("run: a server that answers claimed", () => {
  test("listed on the account as owned: the claim is left alone, no claim token is requested, the server is named, its token kept, the library made", async () => {
    const { ctx, recorded } = fakeContext({ guest: ownedClaimedGuest() });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.plexTv.map((call) => call.url)).toEqual([RESOURCES_URL]);
    expect(recorded.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "PUT /:/prefs?FriendlyName=Plex_Test3",
      "GET /",
      ...LIBRARY_REQUESTS,
    ]);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(ALL_CHECKPOINTS);
    expect(recorded.emitted.find((cp) => cp.id === "claimed")?.message).toBe("Already claimed on your Plex account");
    expect(recorded.secrets[SERVER_TOKEN_SECRET]).toBe(SERVER_TOKEN);
  });

  test("listed on the account but not owned by it (a shared server): the hook stops before any write, with the listed token unrecorded", async () => {
    const { ctx, recorded } = fakeContext({ guest: { "GET /identity": identity(true) } });
    const shared = response([{ name: "Theirs", clientIdentifier: MID, provides: "server", owned: false, accessToken: "shared-token" }]);
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: shared }))).rejects.toThrow("not owned");
    expect(recorded.failed?.context).toContainEqual({ label: "Claimed in this run", value: "no" });
    expect(recorded.requests).toEqual([]);
    expect(recorded.plexTv).toHaveLength(1);
    expect(recorded.secretWrites).toBe(0);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready"]);
    expect(recordedSurfaces(recorded)).not.toContain("shared-token");
  });

  test("listed with an owned flag that is not exactly true is not owned", async () => {
    const { ctx, recorded } = fakeContext({ guest: { "GET /identity": identity(true) } });
    const vague = response([{ clientIdentifier: MID, provides: "server", owned: "true", accessToken: SERVER_TOKEN }]);
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: vague }))).rejects.toThrow("not owned");
    expect(recorded.requests).toEqual([]);
    expect(recorded.secretWrites).toBe(0);
  });

  test("not listed on the account at all: the hook waits out the listing, then stops before any write", async () => {
    const { ctx, recorded } = fakeContext({ guest: { "GET /identity": identity(true) } });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: response([]) }))).rejects.toThrow("does not list this server");
    expect(recorded.plexTv).toHaveLength(RESOURCES_ATTEMPTS);
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual(Array(RESOURCES_ATTEMPTS - 1).fill(10000));
    expect(recorded.requests).toEqual([]);
    expect(recorded.secretWrites).toBe(0);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready"]);
  });
});

describe("run: every write is verified, and a failed or unverified one stops the hook", () => {
  test("a claim Plex refuses is retried the declared number of times, then fails with nothing named or stored", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": identity(false),
        [`POST ${CLAIM_PATH}`]: response("nope", 403),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer }))).rejects.toThrow("did not accept");
    expect(recorded.requests.filter((request) => request.method === "POST")).toHaveLength(CLAIM_ATTEMPTS);
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual(Array(CLAIM_ATTEMPTS - 1).fill(5000));
    expect(recorded.failed?.context).toContainEqual({ label: "Last status", value: "403" });
    expect(recorded.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(recorded.secretWrites).toBe(0);
  });

  test("a claim whose transport fails is logged by the error's kind, never by its message", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": identity(false),
        [`POST ${CLAIM_PATH}`]: Object.assign(new Error(`http://192.0.2.240:32400${CLAIM_PATH} unreachable on redirect`), {
          kind: "unreachable",
        }),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer }))).rejects.toThrow("did not accept");
    expect(recorded.logs.filter((line) => line.startsWith("claim attempt"))).toEqual([
      "claim attempt 1/3 failed: unreachable",
      "claim attempt 2/3 failed: unreachable",
      "claim attempt 3/3 failed: unreachable",
    ]);
    expect(recordedSurfaces(recorded)).not.toContain(CLAIM_TOKEN);
    expect(recorded.failed?.context).toContainEqual({ label: "Last status", value: "no answer" });
  });

  test("a claim Plex accepts but does not report fails rather than continuing", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(false)],
        [`POST ${CLAIM_PATH}`]: response(""),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer }))).rejects.toThrow("still reports itself unclaimed");
    expect(recorded.plexTv.map((call) => call.url)).toEqual([CLAIM_URL]);
    expect(recorded.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(recorded.secretWrites).toBe(0);
  });

  test("a different server answering after the claim fails", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(true, "mid-b")],
        [`POST ${CLAIM_PATH}`]: response(""),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer }))).rejects.toThrow("not the one that was claimed");
    expect(recorded.secretWrites).toBe(0);
  });

  test("plex.tv refusing a claim token fails before any write reaches the guest", async () => {
    const { ctx, recorded } = fakeContext({ guest: { "GET /identity": identity(false) } });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: response("Unauthorized", 401) }))).rejects.toThrow("did not issue a claim token");
    expect(recorded.waits).toHaveLength(1);
    expect(recorded.requests).toEqual([]);
    expect(recorded.secretWrites).toBe(0);
  });

  test("a name Plex refuses, or does not take, fails before any token is stored", async () => {
    const refused = fakeContext({
      guest: {
        "GET /identity": identity(true),
        "PUT /:/prefs?FriendlyName=Plex_Test3": response("", 401),
      },
    });
    await expect(runWith(refused.ctx, fakePlexTv(refused.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("refused the server name");
    expect(refused.recorded.secretWrites).toBe(0);

    const ignored = fakeContext({
      guest: {
        "GET /identity": identity(true),
        "PUT /:/prefs?FriendlyName=Plex_Test3": response(""),
        "GET /": root("ubuntu"),
      },
    });
    await expect(runWith(ignored.ctx, fakePlexTv(ignored.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not take the server name");
    expect(ignored.recorded.failed?.context).toContainEqual({ label: "Reported", value: "ubuntu" });
    expect(ignored.recorded.plexTv).toHaveLength(1);
    expect(ignored.recorded.secretWrites).toBe(0);
    expect(ignored.recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed"]);
  });

  test("a name Plex reports back with XML escaping verifies", async () => {
    const { ctx, recorded } = fakeContext({
      inputs: { plex_login: { authToken: ACCOUNT_TOKEN }, server_name: "A & B" },
      guest: {
        "GET /identity": identity(true),
        "PUT /:/prefs?FriendlyName=A%20%26%20B": response(""),
        "GET /": response(`<MediaContainer size="24" friendlyName="A &amp; B" machineIdentifier="${MID}"/>`),
        ...libraryAnswers(),
      },
    });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.emitted.find((cp) => cp.id === "preferences")?.message).toContain("Named A & B;");
    expect(recorded.secrets[SERVER_TOKEN_SECRET]).toBe(SERVER_TOKEN);
  });

  test("a listing that catches up late is waited for", async () => {
    const { ctx, recorded } = fakeContext({ guest: ownedClaimedGuest() });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: [response([]), response("busy", 503), resourcesAnswer] }));
    expect(recorded.plexTv).toHaveLength(3);
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual([10000, 10000]);
    expect(recorded.secrets[SERVER_TOKEN_SECRET]).toBe(SERVER_TOKEN);
  });

  test("a listed, owned server without a usable token fails at once, before any write", async () => {
    const { ctx, recorded } = fakeContext({ guest: { "GET /identity": identity(true) } });
    const listing = response([{ clientIdentifier: MID, provides: "server", owned: true }]);
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: listing }))).rejects.toThrow("without an access token");
    expect(recorded.plexTv).toHaveLength(1);
    expect(recorded.requests).toEqual([]);
    expect(recorded.secretWrites).toBe(0);
  });

  test("a token the store does not read back fails the hook after the write, with no token checkpoint", async () => {
    const { ctx, recorded } = fakeContext({ readBack: () => undefined, guest: ownedClaimedGuest() });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("read back");
    expect(recorded.secretWrites).toBe(1);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed"]);
  });

  test("a sign-in without a token fails before the guest is asked anything, with no checkpoint completed", async () => {
    const { ctx, recorded } = fakeContext({ inputs: { plex_login: {} }, guest: {} });
    await expect(runWith(ctx, fakePlexTv(recorded, {}))).rejects.toThrow("carried no token");
    expect(recorded.waits).toEqual([]);
    expect(recorded.requests).toEqual([]);
    expect(recorded.emitted).toEqual([]);
  });

  test("a guest that never answers fails before any checkpoint is completed", async () => {
    const { ctx, recorded } = fakeContext({
      guest: { "GET /identity": new Error("Guest not reachable at http://192.0.2.240:32400/identity after 24 attempts") },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, {}))).rejects.toThrow("not reachable");
    expect(recorded.emitted).toEqual([]);
    expect(recorded.requests).toEqual([]);
  });
});

describe("run: the five default media libraries", () => {
  const startingUp = () => response("<html><body>the server is still starting up. Please retry later<br>'agent' is missing or invalid</body></html>", 400);

  test("a partial setup rerun preserves existing libraries and creates only the missing ones", async () => {
    const guest = ownedClaimedGuest();
    const oldMedia = { key: "42", type: "movie", title: "Old Media", Location: [{ path: "/mnt/media" }] };
    const listing = (count: number) => response({ MediaContainer: { Directory: [...sectionEntries.slice(0, count), oldMedia] } });
    guest["GET /library/sections"] = [listing(2), listing(2), listing(2), listing(3), listing(3), listing(4), listing(4), listing(5)];
    const { ctx, recorded } = fakeContext({ guest });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(createPaths.slice(2));
    expect(recorded.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(recorded.requests.filter((r) => r.path.endsWith("/refresh"))).toHaveLength(5);
    expect(recorded.emitted.filter((cp) => cp.message?.includes("already existed"))).toHaveLength(2);
  });

  test("a later library failure preserves completed checkpoints and does not claim all scans ran", async () => {
    const guest = ownedClaimedGuest();
    guest[`POST ${createPaths[2]}`] = response("refused", 400);
    const { ctx, recorded } = fakeContext({ guest });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("/mnt/music");
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed", "preferences", "lib_movies", "lib_tv"]);
    expect(recorded.requests.some((r) => r.path.endsWith("/refresh"))).toBe(false);
    expect(recorded.requests.some((r) => r.path === createPaths[3])).toBe(false);
  });

  test("a successful section listing does not mean agents are ready: an explicit startup refusal is retried", async () => {
    const guest = ownedClaimedGuest();
    guest["GET /library/sections"] = [sectionsNone(), sectionsNone(), ...(libraryAnswers()["GET /library/sections"] as Answer[]).slice(1)];
    guest[`POST ${CREATE_PATH}`] = [startingUp(), response("", 201)];
    const { ctx, recorded } = fakeContext({ guest });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual([5000]);
    expect(recorded.requests.filter((request) => request.path.startsWith("/library/sections")).map((request) => `${request.method} ${request.path}`))
      .toEqual(["GET /library/sections", `POST ${CREATE_PATH}`, ...LIBRARY_REQUESTS.slice(4)]);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(ALL_CHECKPOINTS);
  });

  test("a library appearing during the startup wait is reused without a second creation", async () => {
    const guest = ownedClaimedGuest();
    guest[`POST ${CREATE_PATH}`] = startingUp();
    const { ctx, recorded } = fakeContext({ guest });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.requests.filter((request) => request.method === "POST" && request.path === CREATE_PATH)).toHaveLength(1);
    expect(recorded.emitted.find((cp) => cp.id === "lib_movies")?.message).toContain("already existed");
  });

  test("startup refusals have a bounded retry budget and never claim the media mount failed", async () => {
    const guest = ownedClaimedGuest();
    guest["GET /library/sections"] = sectionsNone();
    guest[`POST ${CREATE_PATH}`] = startingUp();
    const { ctx, recorded } = fakeContext({ guest });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("still starting up");
    expect(recorded.requests.filter((request) => request.method === "POST" && request.path === CREATE_PATH)).toHaveLength(LIBRARY_ATTEMPTS);
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual(Array(LIBRARY_ATTEMPTS - 1).fill(5000));
    expect(recorded.failed?.message).not.toContain("mount");
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed", "preferences"]);
  });

  test("ordinary refusals and ambiguous transport failures are never replayed or exposed as response bodies", async () => {
    for (const refusal of [response(`'agent' is missing or invalid ${ACCOUNT_TOKEN}`, 400), response("the server is still starting up. Please retry later", 403), new Error("request outcome ambiguous")]) {
      const guest = ownedClaimedGuest();
      guest[`POST ${CREATE_PATH}`] = refusal;
      const { ctx, recorded } = fakeContext({ guest });
      await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow();
      expect(recorded.requests.filter((request) => request.method === "POST" && request.path === CREATE_PATH)).toHaveLength(1);
      expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual([]);
      expect(JSON.stringify({ logs: recorded.logs, failure: recorded.failed })).not.toContain(ACCOUNT_TOKEN);
    }
  });

  test("a library already covering the mount is left alone: no creation, trash emptying still turned off, the scan still requested", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": identity(true),
        "PUT /:/prefs?FriendlyName=Plex_Test3": response(""),
        "GET /": root("Plex_Test3"),
        ...libraryAnswers({ existing: true }),
      },
    });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    const paths = recorded.requests.map((request) => `${request.method} ${request.path}`);
    expect(paths).toContain("GET /library/sections");
    expect(paths.some((path) => path.startsWith("POST /library/sections"))).toBe(false);
    expect(paths).toContain(`PUT ${TRASH_OFF_PATH}`);
    expect(paths).toContain(`GET ${REFRESH_PATH}`);
    expect(recorded.emitted.find((cp) => cp.id === "lib_movies")?.message).toBe("Movies at /mnt/movies (already existed)");
    expect(recorded.logs.some((line) => line.includes("already covers"))).toBe(true);
  });

  test("another library elsewhere does not count: the mount gets its own", async () => {
    const guest = ownedClaimedGuest();
    guest["GET /library/sections"] = [sectionsOther(), ...(libraryAnswers()["GET /library/sections"] as Answer[]).slice(1)];
    const { ctx, recorded } = fakeContext({ guest });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.requests.some((request) => request.path === CREATE_PATH && request.method === "POST")).toBe(true);
    expect(recorded.emitted.find((cp) => cp.id === "lib_movies")?.message).toContain("(created)");
  });

  test("a library subsystem that is still starting is waited for", async () => {
    const guest = ownedClaimedGuest();
    guest["GET /library/sections"] = [response("still starting up", 500), response("still starting up", 500), ...(libraryAnswers()["GET /library/sections"] as Answer[])];
    const { ctx, recorded } = fakeContext({ guest });
    await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual([5000, 5000]);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(ALL_CHECKPOINTS);
  });

  test("a library subsystem that never answers fails after the declared attempts, with the token already kept", async () => {
    const guest = ownedClaimedGuest();
    guest["GET /library/sections"] = response("still starting up", 500);
    const { ctx, recorded } = fakeContext({ guest });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("library subsystem did not answer");
    expect(recorded.requests.filter((request) => request.path === "/library/sections")).toHaveLength(LIBRARY_ATTEMPTS);
    expect(recorded.sleeps.filter((ms) => ms !== 2000)).toEqual(Array(LIBRARY_ATTEMPTS - 1).fill(5000));
    expect(recorded.secretWrites).toBe(1);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed", "preferences"]);
  });

  test("a library Plex refuses to create fails without assuming a cause or starting a scan", async () => {
    const guest = ownedClaimedGuest();
    guest[`POST ${CREATE_PATH}`] = response("The location does not exist", 400);
    const { ctx, recorded } = fakeContext({ guest });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("refused to create");
    expect(recorded.failed?.context).toContainEqual({ label: "Status", value: "400" });
    expect(recorded.requests.some((request) => request.path === TRASH_OFF_PATH)).toBe(true);
    expect(recorded.requests.some((request) => request.path === REFRESH_PATH)).toBe(false);
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed", "preferences"]);
  });

  test("a library Plex accepts but does not list fails", async () => {
    const guest = ownedClaimedGuest();
    guest["GET /library/sections"] = sectionsNone();
    const { ctx, recorded } = fakeContext({ guest });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("does not list it");
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed", "preferences"]);
  });

  test("the server preferences Plex refuses, or does not take, fail after trash emptying is off and before the libraries", async () => {
    const refused = ownedClaimedGuest();
    refused[`PUT ${PREFERENCES_PATH}`] = response("", 401);
    const a = fakeContext({ guest: refused });
    await expect(runWith(a.ctx, fakePlexTv(a.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("refused the server preferences");

    const ignored = ownedClaimedGuest();
    ignored["GET /:/prefs"] = prefs({ ...SERVER_PREFERENCES_TAKEN, ScheduledLibraryUpdatesEnabled: false, autoEmptyTrash: false });
    const b = fakeContext({ guest: ignored });
    await expect(runWith(b.ctx, fakePlexTv(b.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not take a server preference");
    expect(b.recorded.failed?.context).toContainEqual({ label: "Preference", value: "ScheduledLibraryUpdatesEnabled" });
    expect(b.recorded.failed?.context).toContainEqual({ label: "Reported", value: "false" });

    const interval = ownedClaimedGuest();
    interval["GET /:/prefs"] = prefs({ ...SERVER_PREFERENCES_TAKEN, ScheduledLibraryUpdateInterval: 86400, autoEmptyTrash: false });
    const c = fakeContext({ guest: interval });
    await expect(runWith(c.ctx, fakePlexTv(c.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not take a server preference");
    expect(c.recorded.failed?.context).toContainEqual({ label: "Preference", value: "ScheduledLibraryUpdateInterval" });
    for (const run of [a, b, c]) {
      // Trash emptying was turned off first; no library was made or scanned.
      expect(run.recorded.requests.some((request) => request.path === TRASH_OFF_PATH)).toBe(true);
      expect(run.recorded.requests.some((request) => request.path === REFRESH_PATH || request.path.startsWith("/library/sections"))).toBe(false);
      expect(run.recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed"]);
    }
  });

  test("a trash-emptying setting Plex refuses, or does not take, fails before the scan", async () => {
    const refused = ownedClaimedGuest();
    refused[`PUT ${TRASH_OFF_PATH}`] = response("", 401);
    const a = fakeContext({ guest: refused });
    await expect(runWith(a.ctx, fakePlexTv(a.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("refused the trash-emptying setting");

    const ignored = ownedClaimedGuest();
    ignored["GET /:/prefs"] = prefsTrash(true);
    const b = fakeContext({ guest: ignored });
    await expect(runWith(b.ctx, fakePlexTv(b.recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not take the trash-emptying setting");
    expect(b.recorded.failed?.context).toContainEqual({ label: "Reported", value: "true" });
    for (const run of [a, b]) {
      // Nothing that scans is written while trash emptying is not confirmed off: no schedule, no library, no scan.
      expect(run.recorded.requests.some((request) => request.path === PREFERENCES_PATH || request.path === REFRESH_PATH)).toBe(false);
      expect(run.recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed"]);
    }
  });

  test("a scan Plex does not start fails, after the library checkpoint", async () => {
    const guest = ownedClaimedGuest();
    guest[`GET ${REFRESH_PATH}`] = response("busy", 500);
    const { ctx, recorded } = fakeContext({ guest });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not start the library scan");
    expect(recorded.failed?.context).toContainEqual({ label: "Library", value: "Movies" });
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["ready", "claimed", "preferences", ...expectedLibraries.map((lib) => lib.checkpointId)]);
  });
});

describe("run: what a failure after a fresh claim says, and what the decoder must not invent", () => {
  test("a listing failure after a successful claim does not claim that nothing was changed", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: response(""),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: response([]) }))).rejects.toThrow(
      "does not list this server",
    );
    expect(recorded.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(recorded.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(recorded.secretWrites).toBe(0);
    expect(JSON.stringify(recorded.failed)).not.toContain("nothing was changed");
    expect(recorded.failed?.context).toContainEqual({ label: "Claimed in this run", value: "yes" });
  });

  test("a not-owned listing on an already-claimed server says nothing was written, and one after a fresh claim says the claim happened", async () => {
    const shared = response([{ clientIdentifier: MID, provides: "server", owned: false, accessToken: "shared-token" }]);
    const before = fakeContext({ guest: { "GET /identity": identity(true) } });
    await expect(runWith(before.ctx, fakePlexTv(before.recorded, { [RESOURCES_URL]: shared }))).rejects.toThrow("not owned");
    expect(before.recorded.failed?.context).toContainEqual({ label: "Claimed in this run", value: "no" });
    const after = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: response(""),
      },
    });
    await expect(runWith(after.ctx, fakePlexTv(after.recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: shared }))).rejects.toThrow("not owned");
    expect(JSON.stringify(after.recorded.failed)).not.toContain("nothing was changed");
    expect(after.recorded.failed?.context).toContainEqual({ label: "Claimed in this run", value: "yes" });
    expect(after.recorded.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  test("a claim transport error without a kind, whose message carries the claim token in another encoding, reaches no recorded surface", async () => {
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": identity(false),
        [`POST ${CLAIM_PATH}`]: new Error("http://192.0.2.240:32400/claim-redirect?token=%63laim-token-1 unreachable on redirect"),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer }))).rejects.toThrow("did not accept");
    expect(recorded.logs.filter((line) => line.startsWith("claim attempt"))).toEqual([
      "claim attempt 1/3 failed: error",
      "claim attempt 2/3 failed: error",
      "claim attempt 3/3 failed: error",
    ]);
    expect(recordedSurfaces(recorded)).not.toContain("laim-token-1");
    expect(recordedSurfaces(recorded)).not.toContain("claim-redirect");
  });

  test("a read-back whose XML is malformed (a raw `<`, a bare or unterminated ampersand) is not Plex's answer, and does not verify a name that reads the same", async () => {
    for (const [requested, raw] of [
      ["A & B", "A & B"],
      ["A &amp", "A &amp"],
      ["A &#xD800; B", "A &#xD800; B"],
      ["A < B", "A < B"],
    ]) {
      const { ctx, recorded } = fakeContext({
        inputs: { plex_login: { authToken: ACCOUNT_TOKEN }, server_name: requested },
        guest: {
          "GET /identity": identity(true),
          [`PUT /:/prefs?FriendlyName=${encodeURIComponent(requested)}`]: response(""),
          "GET /": response(`<MediaContainer friendlyName="${raw}" machineIdentifier="${MID}"/>`),
        },
      });
      await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not take the server name");
      expect(recorded.failed?.context).toContainEqual({ label: "Reported", value: "(none)" });
      expect(recorded.secretWrites).toBe(0);
    }
  });

  test("a well-formed read-back whose decoded text contains an ampersand or a reference verifies", async () => {
    for (const [requested, raw] of [
      ["A & B", "A &amp; B"],
      ["A &amp", "A &amp;amp"],
      ["Tom & Jerry's", "Tom &amp; Jerry&apos;s"],
      ["A < B", "A &lt; B"],
    ]) {
      const { ctx, recorded } = fakeContext({
        inputs: { plex_login: { authToken: ACCOUNT_TOKEN }, server_name: requested },
        guest: {
          "GET /identity": identity(true),
          [`PUT /:/prefs?FriendlyName=${encodeURIComponent(requested)}`]: response(""),
          "GET /": response(`<MediaContainer friendlyName="${raw}" machineIdentifier="${MID}"/>`),
          ...libraryAnswers(),
        },
      });
      await runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }));
      expect(recorded.emitted.find((cp) => cp.id === "preferences")?.message).toContain(`Named ${requested};`);
    }
  });

  test("a read-back built from surrogate references does not verify a name that is the joined character", async () => {
    const { ctx, recorded } = fakeContext({
      inputs: { plex_login: { authToken: ACCOUNT_TOKEN }, server_name: "😀" },
      guest: {
        "GET /identity": identity(true),
        "PUT /:/prefs?FriendlyName=%F0%9F%98%80": response(""),
        "GET /": response(`<MediaContainer friendlyName="&#xD83D;&#xDE00;" machineIdentifier="${MID}"/>`),
      },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, { [RESOURCES_URL]: resourcesAnswer }))).rejects.toThrow("did not take the server name");
    expect(recorded.secretWrites).toBe(0);
  });
});

describe("run: an identity without a claim state", () => {
  test("is not proof of an unclaimed server: no claim token is requested and nothing is posted or written", async () => {
    const { ctx, recorded } = fakeContext({
      guest: { "GET /identity": response({ MediaContainer: { machineIdentifier: MID, version: "1.43.4.10903-e5521bd8c" } }) },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, {}))).rejects.toThrow("not with its identity");
    expect(recorded.plexTv).toEqual([]);
    expect(recorded.requests).toEqual([]);
    expect(recorded.emitted).toEqual([]);
  });

  test("in XML, the same", async () => {
    const { ctx, recorded } = fakeContext({
      guest: { "GET /identity": response(`<MediaContainer size="0" machineIdentifier="${MID}" version="1.43.4.10903-e5521bd8c"/>`) },
    });
    await expect(runWith(ctx, fakePlexTv(recorded, {}))).rejects.toThrow("not with its identity");
    expect(recorded.plexTv).toEqual([]);
    expect(recorded.requests).toEqual([]);
  });
});

describe("readers", () => {
  test("readClaimed takes Plex's representations of the flag and nothing else", () => {
    for (const value of [true, 1, "1", "true"]) expect(readClaimed(value)).toBe(true);
    for (const value of [false, 0, "0", "false"]) expect(readClaimed(value)).toBe(false);
    for (const value of [undefined, null, "", "yes", 2, {}, []]) expect(readClaimed(value)).toBeUndefined();
  });

  test("readIdentity takes Plex's JSON and XML shapes with an explicit claim state, and nothing else", () => {
    expect(readIdentity(identity(false).text())).toEqual({ machineIdentifier: MID, claimed: false, version: "1.43.4.10903-e5521bd8c" });
    expect(readIdentity(`<MediaContainer size="0" claimed="1" machineIdentifier="${MID}" version="1.43.4.10903-e5521bd8c"></MediaContainer>`)).toEqual({
      machineIdentifier: MID,
      claimed: true,
      version: "1.43.4.10903-e5521bd8c",
    });
    expect(readIdentity(`<MediaContainer claimed="0" machineIdentifier="${MID}"/>`)?.claimed).toBe(false);
    expect(readIdentity(JSON.stringify({ MediaContainer: { claimed: "1", machineIdentifier: MID } }))?.claimed).toBe(true);
    expect(readIdentity(JSON.stringify({ MediaContainer: { machineIdentifier: MID } }))).toBeUndefined();
    expect(readIdentity(JSON.stringify({ MediaContainer: { claimed: "maybe", machineIdentifier: MID } }))).toBeUndefined();
    expect(readIdentity(`<MediaContainer machineIdentifier="${MID}"/>`)).toBeUndefined();
    expect(readIdentity("<html>captive</html>")).toBeUndefined();
    expect(readIdentity(JSON.stringify({ MediaContainer: { claimed: true } }))).toBeUndefined();
  });

  test("decodeXmlAttribute decodes the five named references and the numeric ones XML permits, and leaves everything else as written", () => {
    expect(decodeXmlAttribute("A &amp; B &lt;3&gt; &quot;q&quot; &apos;a&apos;")).toBe(`A & B <3> "q" 'a'`);
    expect(decodeXmlAttribute("caf&#233; &#x1F600; &#x9;&#xA;&#xD; &unknown; &#0;")).toBe("café 😀 \t\n\r &unknown; &#0;");
    expect(decodeXmlAttribute("plain & bare &amp")).toBe("plain & bare &amp");
    // Characters XML forbids stay as references: surrogates (singly or paired), controls, the two non-characters, out of range.
    for (const forbidden of ["&#xD800;", "&#xDFFF;", "&#xD83D;&#xDE00;", "&#1;", "&#x1F;", "&#xFFFE;", "&#xFFFF;", "&#x110000;", "&#0;"]) {
      expect(decodeXmlAttribute(forbidden)).toBe(forbidden);
    }
    // Only the five named entities, by own property: nothing inherited from Object.
    for (const inherited of ["&constructor;", "&toString;", "&__proto__;", "&hasOwnProperty;"]) {
      expect(decodeXmlAttribute(inherited)).toBe(inherited);
    }
  });

  test("readFriendlyName reads the root document in either shape, decoding XML escapes", () => {
    expect(readFriendlyName(root("Plex_Test3").text())).toBe("Plex_Test3");
    expect(readFriendlyName(`<MediaContainer friendlyName="ubuntu" machineIdentifier="${MID}"/>`)).toBe("ubuntu");
    expect(readFriendlyName(`<MediaContainer friendlyName="A &amp; B" machineIdentifier="${MID}"/>`)).toBe("A & B");
    expect(readFriendlyName(`<MediaContainer friendlyName="A &amp;amp" machineIdentifier="${MID}"/>`)).toBe("A &amp");
    expect(readFriendlyName(root("A & B").text())).toBe("A & B");
    expect(readFriendlyName("Unauthorized")).toBeUndefined();
  });

  test("an XML attribute with a raw `<`, or whose ampersands do not all begin a complete, permitted reference, is not read at all", () => {
    for (const raw of ["A & B", "A &amp", "A &amp B", "&#xD800;", "&#1;", "&#x110000;", "&constructor;", "&unknown;", "&#;", "&", "A < B", "<"]) {
      expect(readFriendlyName(`<MediaContainer friendlyName="${raw}" machineIdentifier="${MID}"/>`)).toBeUndefined();
      expect(readIdentity(`<MediaContainer claimed="1" machineIdentifier="${raw}"/>`)).toBeUndefined();
    }
    for (const raw of ["plain", "A &amp; B", "caf&#233;", "&#x1F600;", "&lt;&gt;&quot;&apos;", "&#x9;&#xA;&#xD;"]) {
      expect(readFriendlyName(`<MediaContainer friendlyName="${raw}" machineIdentifier="${MID}"/>`)).toBeDefined();
    }
  });

  test("readServerToken picks the server by machine identifier and tells unlisted, shared and tokenless apart", () => {
    expect(readServerToken(resourcesAnswer.text(), MID)).toEqual({ listed: true, owned: true, accessToken: SERVER_TOKEN });
    expect(readServerToken(resourcesAnswer.text(), "mid-other")).toEqual({ listed: true, owned: false, accessToken: "not-ours" });
    expect(readServerToken(resourcesAnswer.text(), "mid-unknown")).toEqual({ listed: false });
    expect(readServerToken(JSON.stringify([{ clientIdentifier: MID, owned: true }]), MID)).toEqual({ listed: true, owned: true, accessToken: undefined });
    expect(readServerToken(JSON.stringify([{ clientIdentifier: MID, accessToken: SERVER_TOKEN }]), MID)).toEqual({
      listed: true,
      owned: false,
      accessToken: SERVER_TOKEN,
    });
    expect(readServerToken("<html>", MID)).toEqual({ listed: false });
  });

  test("readSections reads Plex's sections document, an empty one, and nothing else", () => {
    expect(readSections(sectionsMedia().text())).toEqual([{ key: "7", title: "Movies", type: "movie", locations: ["/mnt/movies"] }]);
    expect(readSections(sectionsNone().text())).toEqual([]);
    expect(readSections(JSON.stringify({ MediaContainer: { Directory: [{ key: "1", title: "No locations", type: "show" }] } }))).toEqual([
      { key: "1", title: "No locations", type: "show", locations: [] },
    ]);
    expect(readSections(JSON.stringify({ MediaContainer: { Directory: [{ key: 1, title: "bad key" }] } }))).toBeUndefined();
    expect(readSections(JSON.stringify({ MediaContainer: { Directory: "nope" } }))).toBeUndefined();
    expect(readSections("still starting up")).toBeUndefined();
    expect(readSections("<html>")).toBeUndefined();
  });

  test("readPreference finds one setting's value in Plex's preferences document", () => {
    expect(readPreference(prefsTrash(false).text(), "autoEmptyTrash")).toBe(false);
    expect(readPreference(prefsTrash("0").text(), "autoEmptyTrash")).toBe("0");
    expect(readPreference(prefsTrash(true).text(), "FriendlyName")).toBeUndefined();
    expect(readPreference("Unauthorized", "autoEmptyTrash")).toBeUndefined();
  });

  test("classifyGuestError reports a transport error's kind from the allowlist, and 'error' for anything else", () => {
    expect(classifyGuestError(Object.assign(new Error("x"), { kind: "unreachable" }))).toBe("unreachable");
    expect(classifyGuestError(Object.assign(new Error("x"), { kind: "timeout" }))).toBe("timeout");
    expect(classifyGuestError(Object.assign(new Error("http://host/claim?token=%63laim-token-1"), { kind: "http://host/claim?token=%63laim-token-1" }))).toBe("error");
    expect(classifyGuestError(new Error("http://host/claim?token=%63laim-token-1 unreachable on redirect"))).toBe("error");
    expect(classifyGuestError("string")).toBe("error");
    expect(classifyGuestError(undefined)).toBe("error");
  });

  test("readAccountToken takes the dialog's result object or a bare token", () => {
    expect(readAccountToken({ authToken: ACCOUNT_TOKEN })).toBe(ACCOUNT_TOKEN);
    expect(readAccountToken(ACCOUNT_TOKEN)).toBe(ACCOUNT_TOKEN);
    expect(readAccountToken({ authToken: "" })).toBeUndefined();
    expect(readAccountToken("")).toBeUndefined();
    expect(readAccountToken(undefined)).toBeUndefined();
    expect(readAccountToken(42)).toBeUndefined();
  });
});

describe("a refused claim on a server that then reports itself claimed", () => {
  test("is reconciled from the identity, ownership decided by the account's listing, and the checkpoint says so; a server still unclaimed fails as before", async () => {
    const refused = [response("", 401), response("", 401), response("", 401)];
    const { ctx, recorded } = fakeContext({
      guest: {
        "GET /identity": [identity(false), identity(true)],
        [`POST ${CLAIM_PATH}`]: refused,
        "PUT /:/prefs?FriendlyName=Plex_Test3": response(""),
        "GET /": root("Plex_Test3"),
        ...libraryAnswers(),
      },
    });
    const plexTv = fakePlexTv(recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: resourcesAnswer });
    await runWith(ctx, plexTv);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.emitted.find((cp) => cp.id === "claimed")?.message).toContain("reconciled from the server, not acknowledged");
    expect(recorded.secrets[SERVER_TOKEN_SECRET]).toBe(SERVER_TOKEN);
    expect(recorded.logs.some((line) => line.includes("now reports itself claimed"))).toBe(true);

    // Reconciled, then not owned by the signed-in account: no token is stored, and the diagnostic keeps the distinction.
    const notOwned = fakeContext({
      guest: { "GET /identity": [identity(false), identity(true)], [`POST ${CLAIM_PATH}`]: [response("", 401), response("", 401), response("", 401)] },
    });
    const otherAccount = fakePlexTv(notOwned.recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: response([]) });
    await expect(runWith(notOwned.ctx, otherAccount)).rejects.toThrow();
    expect(notOwned.recorded.secrets[SERVER_TOKEN_SECRET]).toBeUndefined();
    expect(notOwned.recorded.failed?.context?.find((entry) => entry.label === "Claimed in this run")?.value).toBe("reconciled from the server, not acknowledged");

    const stillUnclaimed = fakeContext({
      guest: { "GET /identity": [identity(false), identity(false)], [`POST ${CLAIM_PATH}`]: [response("", 401), response("", 401), response("", 401)] },
    });
    const tv = fakePlexTv(stillUnclaimed.recorded, { [CLAIM_URL]: claimTokenAnswer, [RESOURCES_URL]: resourcesAnswer });
    await expect(runWith(stillUnclaimed.ctx, tv)).rejects.toThrow("Plex did not accept the claim");
    expect(stillUnclaimed.recorded.failed?.context).toEqual([
      { label: "Endpoint", value: "POST /myplex/claim" },
      { label: "Last status", value: "401" },
    ]);
  });
});

describe("onMediaReconnected", () => {
  const allSections = () => response({ MediaContainer: { size: 5, Directory: sectionEntries } });
  const recovery = (guest: Record<string, Answers>, opts: { secrets?: Record<string, string>; folders?: unknown } = {}) =>
    fakeContext({
      guest,
      event: "onMediaReconnected",
      eventData: { folders: opts.folders ?? ["Photos", "Media"] },
      secrets: opts.secrets ?? { [SERVER_TOKEN_SECRET]: SERVER_TOKEN },
    });

  test("reads the folders the platform names and maps a folder to its library by mount path", () => {
    expect(readReconnectedFolders({ folders: ["Photos", "Videos"] })).toEqual(["Photos", "Videos"]);
    expect(readReconnectedFolders({ folders: ["Photos", 7] })).toBeUndefined();
    expect(readReconnectedFolders({})).toBeUndefined();
    expect(libraryForFolder("Shows")?.name).toBe("TV Shows");
    expect(libraryForFolder("Media")).toBeUndefined();
  });

  test("requests a scan for each reconnected folder's library with the server token, and skips a folder without a library, each by checkpoint id", async () => {
    const { ctx, recorded } = recovery({
      "GET /identity": [identity(true)],
      "GET /library/sections": [allSections()],
      "GET /library/sections/10/refresh": [response({}, 200)],
    });
    await onMediaReconnected(ctx);
    expect(recorded.registered).toEqual(["media:Photos", "media:Media"]);
    expect(recorded.emitted).toEqual([{ id: "media:Photos", message: "Scan requested for Photos" }]);
    expect(recorded.skipped).toEqual(["media:Media"]);
    expect(recorded.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /library/sections",
      "GET /library/sections/10/refresh",
    ]);
    expect(recorded.requests[1]?.headers["X-Plex-Token"]).toBe(SERVER_TOKEN);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.secretWrites).toBe(0);
  });

  test("without a server token every folder is skipped and the guest is not asked; a library missing on the server is skipped by name", async () => {
    const { ctx, recorded } = recovery({}, { secrets: {} });
    await onMediaReconnected(ctx);
    expect(recorded.skipped).toEqual(["media:Photos", "media:Media"]);
    expect(recorded.requests).toEqual([]);
    expect(recorded.waits).toEqual([]);
    const missing = recovery(
      { "GET /identity": [identity(true)], "GET /library/sections": [response({ MediaContainer: { size: 0, Directory: [] } })] },
      { folders: ["Photos"] },
    );
    await onMediaReconnected(missing.ctx);
    expect(missing.recorded.skipped).toEqual(["media:Photos"]);
    expect(missing.recorded.emitted).toEqual([]);
  });

  test("a refused token fails by name; a refused scan fails after the folders before it were handled; an event naming no folders fails", async () => {
    const refused = recovery({ "GET /identity": [identity(true)], "GET /library/sections": [response({}, 401)] });
    await expect(onMediaReconnected(refused.ctx)).rejects.toThrow("Plex refused the server token");
    const partial = recovery(
      {
        "GET /identity": [identity(true)],
        "GET /library/sections": [allSections()],
        "GET /library/sections/10/refresh": [response({}, 200)],
        "GET /library/sections/11/refresh": [response({}, 500)],
      },
      { folders: ["Photos", "Videos"] },
    );
    await expect(onMediaReconnected(partial.ctx)).rejects.toThrow("Plex refused the scan of Videos");
    expect(partial.recorded.emitted).toEqual([{ id: "media:Photos", message: "Scan requested for Photos" }]);
    expect(partial.recorded.failed?.context).toEqual([
      { label: "Status", value: "500" },
      { label: "Section", value: "11" },
    ]);
    const empty = recovery({}, { folders: [] });
    await expect(onMediaReconnected(empty.ctx)).rejects.toThrow("The event named no folders");
    const malformed = recovery({}, { folders: "Photos" });
    await expect(onMediaReconnected(malformed.ctx)).rejects.toThrow("The event named no folders");
  });
});
