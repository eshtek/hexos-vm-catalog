import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VMHookContext, VMHookResponse, WaitForAppOptions } from "../_lib/hook_context";
import { describeOnboarding, readOnboarding, run } from "./haos_setup";

// The hook's whole contract: it confirms the guest answers, reads the onboarding
// status once Core answers it (waiting out the landing page of a first boot),
// records only what that read establishes, and sends nothing else.

function response(
  payload: unknown,
  status = 200,
  url = "http://192.0.2.201:8123/",
  headers: VMHookResponse["headers"] = {},
): VMHookResponse {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    status,
    headers,
    body: new TextEncoder().encode(text),
    text: () => text,
    json: () => JSON.parse(text),
    url,
    hops: 0,
  };
}

interface Recorded {
  registered: Array<{ id: string; message: string }>;
  emitted: Array<{ id: string; message?: string; progress?: number }>;
  skipped: Array<{ id: string; message?: string }>;
  fetches: Array<{ path: string; method: string; timeoutMs?: number }>;
  waits: Array<{ path: string; opts?: WaitForAppOptions }>;
  messages: Array<{ id: string; message: string }>;
  progress: number[];
  sleeps: number[];
  logs: string[];
  secretWrites: number;
  failed?: { message: string; context?: Array<{ label: string; value: string }> };
}

type Answer = VMHookResponse | Error;

// One attempt's time as the blueprint declares it, less a margin for the
// checkpoint writes after the wait: a hook still waiting when the attempt ends
// records nothing.
const declared = JSON.parse(readFileSync(join(import.meta.dir, "../home-assistant-os.json"), "utf8")) as {
  hooks: Array<{ id: string; timeout: number }>;
};
const ATTEMPT_LIMIT_MS = (declared.hooks.find((hook) => hook.id === "onboarding")?.timeout ?? 0) * 1000 - 30_000;

// The hook measures its wait on performance.now(). Here that clock moves only
// when the hook sleeps or a request takes time.
let now = 0;
let clock: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  now = 1_000;
  clock = spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  clock?.mockRestore();
});
function advance(ms: number): void {
  now += ms;
}

const ENDED = "Setup attempt ended; a request to the guest is no longer accepted";

/**
 * `onboarding` is one answer for every read, or a sequence the reads take in
 * order (the last one repeats). `frontTakesMs` and `readTakesMs` are how long
 * the front page wait and each read take on the clock. `endsAfterReads` ends
 * the attempt after that many reads: from then on the context refuses every
 * effect, as the platform's does.
 */
function fakeContext(answers: {
  front: Answer;
  onboarding: Answer | Answer[];
  frontTakesMs?: number;
  readTakesMs?: number;
  endsAfterReads?: number;
}): { ctx: VMHookContext; recorded: Recorded } {
  const recorded: Recorded = {
    registered: [],
    emitted: [],
    skipped: [],
    fetches: [],
    waits: [],
    messages: [],
    progress: [],
    sleeps: [],
    logs: [],
    secretWrites: 0,
  };
  const reads = Array.isArray(answers.onboarding) ? answers.onboarding : [answers.onboarding];
  const assertLive = () => {
    if (answers.endsAfterReads !== undefined && recorded.fetches.length >= answers.endsAfterReads) throw new Error(ENDED);
  };
  const ctx = {
    resourceType: "vm",
    resourceId: "instance-a",
    vm: { instanceId: "instance-a", vmUuid: "uuid-a", name: "Home_Assistant", blueprintId: "haos" },
    event: "onAfterReady",
    host: "192.0.2.201",
    port: 8123,
    baseUrl: "http://192.0.2.201:8123",
    inputs: {},
    mounts: [],
    secrets: {
      get: async () => undefined,
      set: async () => {
        recorded.secretWrites++;
      },
      delete: async () => {
        recorded.secretWrites++;
      },
      list: async () => ({}),
    },
    fetch: async (path: string, init?: { method?: string; timeoutMs?: number }) => {
      assertLive();
      recorded.fetches.push({ path, method: init?.method ?? "GET", timeoutMs: init?.timeoutMs });
      const answer = reads[Math.min(recorded.fetches.length, reads.length) - 1] as Answer;
      advance(answers.readTakesMs ?? 0);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    getInstalledAppUrl: async () => null,
    getInput: () => {
      throw new Error("no inputs");
    },
    log: (message: string) => {
      recorded.logs.push(message);
    },
    sleep: async (ms: number) => {
      recorded.sleeps.push(ms);
      advance(ms);
    },
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      recorded.failed = { message, context };
      throw new Error(message);
    },
    registerCheckpoints: async (checkpoints: Array<{ id: string; message: string }>) => {
      recorded.registered.push(...checkpoints);
    },
    emitCheckpoint: async (id: string, message?: string, progress?: number) => {
      assertLive();
      recorded.emitted.push({ id, message, progress });
    },
    updateCheckpointMessage: async (id: string, message: string) => {
      assertLive();
      recorded.messages.push({ id, message });
    },
    setProgress: async (percent: number) => {
      assertLive();
      recorded.progress.push(percent);
    },
    skipCheckpoint: async (id: string, message?: string) => {
      assertLive();
      recorded.skipped.push({ id, message });
    },
    getFailedAtCheckpoint: () => undefined,
    awaitCheckpointRetry: async () => "skip" as const,
    waitForApp: async (path: string, opts?: WaitForAppOptions) => {
      recorded.waits.push({ path, opts });
      advance(answers.frontTakesMs ?? 0);
      if (answers.front instanceof Error) throw answers.front;
      return answers.front;
    },
  } as unknown as VMHookContext;
  return { ctx, recorded };
}

const FRESH = [
  { step: "user", done: false },
  { step: "core_config", done: false },
  { step: "analytics", done: false },
  { step: "integration", done: false },
];

describe("readOnboarding", () => {
  test("a fresh install has every step pending", () => {
    expect(readOnboarding(FRESH)).toEqual({
      onboarded: false,
      pending: ["user", "core_config", "analytics", "integration"],
      steps: ["user", "core_config", "analytics", "integration"],
    });
  });

  test("an onboarded instance has none", () => {
    const state = readOnboarding([
      { step: "user", done: true },
      { step: "core_config", done: true },
    ]);
    expect(state?.onboarded).toBe(true);
    expect(state?.pending).toEqual([]);
  });

  test("anything that is not the status view reads as undefined, and an empty list is not onboarded", () => {
    expect(readOnboarding({ step: "user", done: false })).toBeUndefined();
    expect(readOnboarding([{ step: "user" }])).toBeUndefined();
    expect(readOnboarding([{ step: 1, done: true }])).toBeUndefined();
    expect(readOnboarding("<html>")).toBeUndefined();
    expect(readOnboarding([])?.onboarded).toBe(false);
  });
});

describe("describeOnboarding", () => {
  test("establishes fresh and onboarded from the status view", () => {
    expect(describeOnboarding(response(FRESH))).toEqual({ known: true, message: "Fresh install: finish onboarding in the browser (4 of 4 steps remain)" });
    expect(describeOnboarding(response([{ step: "user", done: true }]))).toEqual({ known: true, message: "Onboarded: an owner account already exists" });
  });

  test("a 404 is 'not served', consistent with an onboarded instance after a restart, and never proof of an owner", () => {
    const described = describeOnboarding(response("Not found", 404));
    expect(described.known).toBe(false);
    expect(described.message).toContain("not served");
    expect(described.message).not.toMatch(/^Onboarded/);
  });

  test("a bare 401 is the Supervisor's landing page, still preparing Core, and is unknown", () => {
    expect(describeOnboarding(response("Unauthorized\n", 401))).toEqual({
      known: false,
      message: "Home Assistant is still preparing its first start. Open it in the browser to check onboarding.",
    });
  });

  test("a 401 that asks for credentials is something else answering, not the landing page", () => {
    const challenge = response("Unauthorized", 401, "http://192.0.2.201/api/onboarding", { "www-authenticate": 'Basic realm="proxy"' });
    expect(describeOnboarding(challenge)).toMatchObject({ known: false, message: expect.stringContaining("unavailable (HTTP 401)") });
  });

  test("other statuses, non-status answers and an empty list are unknown, with the browser as the next step", () => {
    expect(describeOnboarding(response("busy", 503)).known).toBe(false);
    expect(describeOnboarding(response("<html>captive</html>", 200))).toMatchObject({ known: false, message: expect.stringContaining("unreadable") });
    expect(describeOnboarding(response([], 200))).toMatchObject({ known: false, message: expect.stringContaining("no steps") });
    for (const answer of [response("busy", 503), response("<html>", 200), response([], 200)]) {
      expect(describeOnboarding(answer).message).toContain("browser");
    }
  });
});

describe("run", () => {
  test("registers its two checkpoints, waits for the front page, reads the status once, and records a fresh install", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: response(FRESH) });
    await run(ctx);
    expect(recorded.registered.map((cp) => cp.id)).toEqual(["reachable", "onboarding"]);
    expect(recorded.waits).toEqual([{ path: "/", opts: { maxAttempts: 24 } }]);
    expect(recorded.fetches).toEqual([{ path: "/api/onboarding", method: "GET", timeoutMs: 10_000 }]);
    expect(recorded.emitted[0]).toEqual({ id: "reachable", message: "Home Assistant answered at http://192.0.2.201:8123/", progress: 50 });
    expect(recorded.emitted[1]).toEqual({ id: "onboarding", message: "Fresh install: finish onboarding in the browser (4 of 4 steps remain)", progress: undefined });
    expect(recorded.skipped).toEqual([]);
    expect(recorded.sleeps).toEqual([]);
    expect(recorded.progress).toEqual([]);
  });

  test("records an onboarded instance and leaves it alone", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: response([{ step: "user", done: true }]) });
    await run(ctx);
    expect(recorded.emitted[1]?.message).toContain("Onboarded");
    expect(recorded.logs.some((line) => line.includes("Onboarded"))).toBe(true);
  });

  test("an onboarded instance that restarted (status view 404) completes with the state recorded as not served, not as onboarded", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: response("Not found", 404) });
    await run(ctx);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["reachable"]);
    expect(recorded.skipped).toEqual([{ id: "onboarding", message: expect.stringContaining("not served") }]);
  });

  test("sends the guest nothing but the front page poll and the one status read: no other request, no secret", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: response(FRESH) });
    await run(ctx);
    expect(recorded.waits).toHaveLength(1);
    expect(recorded.fetches).toHaveLength(1);
    expect(recorded.secretWrites).toBe(0);
  });

  test("an answer that is not the status view is recorded as unreadable, and the hook still completes", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: response("<html>captive</html>", 200) });
    await run(ctx);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.skipped[0]?.message).toContain("unreadable");
  });

  // A fresh install's first boot serves the Supervisor's landing page until
  // Core is pulled and started: it answers the front page with 200 and every
  // /api/ path with 401, and Core never answers the status view with 401.
  const LANDING = response("Unauthorized\n", 401, "http://192.0.2.201/api/onboarding");

  test("a fresh install still on the landing page waits for Core and records Core's answer", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: [LANDING, LANDING, response(FRESH)] });
    await run(ctx);
    expect(recorded.fetches).toHaveLength(3);
    expect(recorded.fetches.every((f) => f.path === "/api/onboarding" && f.method === "GET")).toBe(true);
    expect(recorded.sleeps).toEqual([10_000, 10_000]);
    expect(recorded.messages).toEqual([{ id: "onboarding", message: "Waiting for Home Assistant to finish preparing" }]);
    expect(recorded.progress).toHaveLength(2);
    expect(recorded.progress.every((percent) => percent >= 50 && percent < 95)).toBe(true);
    expect(recorded.emitted[1]).toEqual({ id: "onboarding", message: "Fresh install: finish onboarding in the browser (4 of 4 steps remain)", progress: undefined });
    expect(recorded.skipped).toEqual([]);
    expect(recorded.secretWrites).toBe(0);
  });

  test("the moment between the landing page and Core, when nothing answers, is waited through", async () => {
    const { ctx, recorded } = fakeContext({
      front: response("<html>", 200),
      onboarding: [LANDING, new Error("connect ECONNREFUSED 192.0.2.201:80"), response([{ step: "user", done: true }])],
    });
    await run(ctx);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.fetches).toHaveLength(3);
    expect(recorded.sleeps).toHaveLength(2);
    expect(recorded.emitted[1]?.message).toContain("Onboarded");
  });

  test("a 401 that asks for credentials is recorded at once, without waiting", async () => {
    const challenge = response("Unauthorized", 401, "http://192.0.2.201/api/onboarding", { "www-authenticate": 'Basic realm="proxy"' });
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: challenge });
    await run(ctx);
    expect(recorded.fetches).toHaveLength(1);
    expect(recorded.skipped[0]?.message).toContain("unavailable (HTTP 401)");
  });

  test("Core's 404 on the first read is recorded at once, without waiting", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: response("Not found", 404) });
    await run(ctx);
    expect(recorded.fetches).toHaveLength(1);
    expect(recorded.sleeps).toEqual([]);
  });

  test("a landing page that outlasts the wait is recorded as still preparing, inside the declared timeout", async () => {
    const started = performance.now();
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: LANDING, readTakesMs: 10_000 });
    await run(ctx);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.skipped).toEqual([{ id: "onboarding", message: expect.stringContaining("still preparing") }]);
    expect(recorded.fetches.length).toBeGreaterThan(10);
    expect(performance.now() - started).toBeLessThan(ATTEMPT_LIMIT_MS);
  });

  test("a front page that took most of the budget still leaves one read, and the hook ends inside the declared timeout", async () => {
    const started = performance.now();
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: LANDING, frontTakesMs: 450_000, readTakesMs: 10_000 });
    await run(ctx);
    expect(recorded.fetches.length).toBeGreaterThanOrEqual(1);
    expect(recorded.skipped[0]?.message).toContain("still preparing");
    expect(performance.now() - started).toBeLessThan(ATTEMPT_LIMIT_MS);
  });

  test("a read that fails at the end of a landing page wait still records the landing page, not an outage", async () => {
    const { ctx, recorded } = fakeContext({
      front: response("<html>", 200),
      onboarding: [LANDING, new Error("no response within 10000ms")],
    });
    await run(ctx);
    expect(recorded.skipped[0]?.message).toContain("still preparing");
  });

  test("a guest that stops answering after the front page is recorded as unavailable, logs each new error once, and still completes", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: new Error("connect ECONNREFUSED 192.0.2.201:80") });
    await run(ctx);
    expect(recorded.failed).toBeUndefined();
    expect(recorded.emitted.map((cp) => cp.id)).toEqual(["reachable"]);
    expect(recorded.skipped).toEqual([{ id: "onboarding", message: expect.stringContaining("did not answer") }]);
    expect(recorded.logs.filter((line) => line.includes("got no answer"))).toEqual([
      "Home Assistant onboarding read got no answer: connect ECONNREFUSED 192.0.2.201:80",
    ]);
  });

  test("an attempt that ends while waiting stops the wait at once, and records nothing after", async () => {
    const { ctx, recorded } = fakeContext({ front: response("<html>", 200), onboarding: LANDING, endsAfterReads: 2 });
    await expect(run(ctx)).rejects.toThrow("Setup attempt ended");
    expect(recorded.fetches).toHaveLength(2);
    expect(recorded.sleeps).toHaveLength(1);
    expect(recorded.skipped).toEqual([]);
  });

  test("a guest that never answers fails before any checkpoint is completed", async () => {
    const { ctx, recorded } = fakeContext({
      front: new Error("Guest not reachable at http://192.0.2.201:8123/ after 24 attempts"),
      onboarding: response(FRESH),
    });
    await expect(run(ctx)).rejects.toThrow("not reachable");
    expect(recorded.emitted).toEqual([]);
    expect(recorded.fetches).toEqual([]);
  });
});
