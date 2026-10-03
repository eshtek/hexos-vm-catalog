import { describe, expect, test } from "bun:test";
import type { VMHookContext, VMHookResponse, WaitForAppOptions } from "../_lib/hook_context";
import { describeOnboarding, readOnboarding, run } from "./haos_setup";

// The hook's whole contract: it confirms the guest answers, reads the onboarding
// status once, records only what that read establishes, and sends nothing else.

function response(payload: unknown, status = 200, url = "http://192.0.2.201:8123/"): VMHookResponse {
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

interface Recorded {
  registered: Array<{ id: string; message: string }>;
  emitted: Array<{ id: string; message?: string; progress?: number }>;
  skipped: Array<{ id: string; message?: string }>;
  fetches: Array<{ path: string; method: string }>;
  waits: Array<{ path: string; opts?: WaitForAppOptions }>;
  logs: string[];
  secretWrites: number;
  failed?: { message: string; context?: Array<{ label: string; value: string }> };
}

function fakeContext(answers: {
  front: VMHookResponse | Error;
  onboarding: VMHookResponse | Error;
}): { ctx: VMHookContext; recorded: Recorded } {
  const recorded: Recorded = { registered: [], emitted: [], skipped: [], fetches: [], waits: [], logs: [], secretWrites: 0 };
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
    fetch: async (path: string, init?: { method?: string }) => {
      recorded.fetches.push({ path, method: init?.method ?? "GET" });
      if (answers.onboarding instanceof Error) throw answers.onboarding;
      return answers.onboarding;
    },
    getInstalledAppUrl: async () => null,
    getInput: () => {
      throw new Error("no inputs");
    },
    log: (message: string) => {
      recorded.logs.push(message);
    },
    sleep: async () => {},
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      recorded.failed = { message, context };
      throw new Error(message);
    },
    registerCheckpoints: async (checkpoints: Array<{ id: string; message: string }>) => {
      recorded.registered.push(...checkpoints);
    },
    emitCheckpoint: async (id: string, message?: string, progress?: number) => {
      recorded.emitted.push({ id, message, progress });
    },
    updateCheckpointMessage: async () => {},
    setProgress: async () => {},
    skipCheckpoint: async (id: string, message?: string) => {
      recorded.skipped.push({ id, message });
    },
    getFailedAtCheckpoint: () => undefined,
    awaitCheckpointRetry: async () => "skip" as const,
    waitForApp: async (path: string, opts?: WaitForAppOptions) => {
      recorded.waits.push({ path, opts });
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
    expect(recorded.fetches).toEqual([{ path: "/api/onboarding", method: "GET" }]);
    expect(recorded.emitted[0]).toEqual({ id: "reachable", message: "Home Assistant answered at http://192.0.2.201:8123/", progress: 50 });
    expect(recorded.emitted[1]).toEqual({ id: "onboarding", message: "Fresh install: finish onboarding in the browser (4 of 4 steps remain)", progress: undefined });
    expect(recorded.skipped).toEqual([]);
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
