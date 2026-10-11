import type { VMHookContext, VMHookResponse } from "../_lib/hook_context";

/**
 * Home Assistant OS, after the guest is ready: confirms Home Assistant answers
 * and records what can be established about its onboarding.
 *
 * Writes nothing to the guest. Creating the owner account is deliberately
 * absent: a fresh install is the user's to onboard in the browser, a restore
 * or migration carries that intent itself, and an existing owner is a
 * recovery case, never permission to overwrite. The value of this hook is the
 * seam: the platform has verified the guest's identity and reachability by
 * the time it runs, and the recorded state is what a later consumer reads.
 *
 * What the onboarding status view (`GET /api/onboarding`, no authentication)
 * can and cannot say, per homeassistant/components/onboarding/__init__.py:
 * while any step is still to do, and after onboarding completes in the same
 * process, it answers `[{ step, done }]`; an instance that starts already
 * onboarded never registers the view, so it answers 404. A 404 therefore
 * means "not served", which is consistent with an onboarded instance and
 * with nothing else being known; it is recorded as unknown, never as proof
 * that an owner exists.
 *
 * A fresh install's first boot serves the Supervisor's landing page
 * ("Preparing Home Assistant") until Core is pulled and started, often
 * minutes after the guest first answers. The read waits for Core, within
 * the declaration's 600 s timeout, and says so when Core is still not up.
 */

const ROOT_PATH = "/";
const ONBOARDING_PATH = "/api/onboarding";
/** Attempts at the platform's back-off (5 s growing to 15 s): about six minutes. */
const REACHABLE_ATTEMPTS = 24;
/**
 * The wait for Core ends this long after the run starts, so its outcome is
 * recorded before the declaration's 600 s timeout ends the attempt.
 */
const CORE_WAIT_BUDGET_MS = 540_000;
const CORE_WAIT_INTERVAL_MS = 10_000;
/** The platform's default, named because the budget counts it. */
const CORE_READ_TIMEOUT_MS = 10_000;
const NO_ANSWER = {
  known: false,
  message: "Onboarding state unavailable: Home Assistant did not answer the status read. Open it in the browser to check.",
};

export interface OnboardingState {
  /** Every onboarding step is done: an owner account exists. */
  onboarded: boolean;
  /** The steps still to do, in Home Assistant's order. */
  pending: string[];
  steps: string[];
}

/**
 * Reads Home Assistant's onboarding status: an array of `{ step, done }`.
 * Anything else is not the status view (a captive page, a proxy, a future
 * shape) and reads as undefined rather than as a guess. An empty list
 * establishes nothing either way and reads as not onboarded.
 */
export function readOnboarding(payload: unknown): OnboardingState | undefined {
  if (!Array.isArray(payload)) return undefined;
  const steps: string[] = [];
  const pending: string[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { step, done } = entry as { step?: unknown; done?: unknown };
    if (typeof step !== "string" || typeof done !== "boolean") return undefined;
    steps.push(step);
    if (!done) pending.push(step);
  }
  return { onboarded: steps.length > 0 && pending.length === 0, pending, steps };
}

/**
 * The landing page answers every /api/ path with a bare 401
 * (home-assistant/landingpage, main.go); a proxy asking for credentials sends
 * WWW-Authenticate with its 401. Core never answers the status view with 401:
 * the view takes no authentication, and Core's HTTP server starts only after
 * its frontend, which depends on onboarding, is set up.
 */
function isLandingPage(response: Pick<VMHookResponse, "status" | "headers">): boolean {
  return response.status === 401 && response.headers["www-authenticate"] === undefined;
}

/** What the recorded checkpoint says for each thing the status view can establish. */
export function describeOnboarding(response: Pick<VMHookResponse, "status" | "headers"> & { json(): unknown }): {
  known: boolean;
  message: string;
} {
  if (response.status === 404) {
    return {
      known: false,
      message:
        "Onboarding state not served: Home Assistant hides it once onboarding is complete and it has restarted. Open it in the browser to check.",
    };
  }
  if (isLandingPage(response)) {
    return { known: false, message: "Home Assistant is still preparing its first start. Open it in the browser to check onboarding." };
  }
  if (response.status !== 200) {
    return { known: false, message: `Onboarding state unavailable (HTTP ${response.status}). Open Home Assistant in the browser to check.` };
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    payload = undefined;
  }
  const state = readOnboarding(payload);
  if (!state) {
    return { known: false, message: "Onboarding state unreadable: the answer was not Home Assistant's status. Open it in the browser to check." };
  }
  if (state.steps.length === 0) {
    return { known: false, message: "Onboarding state unknown: Home Assistant listed no steps. Open it in the browser to check." };
  }
  if (state.onboarded) return { known: true, message: "Onboarded: an owner account already exists" };
  // A count, not Home Assistant's step ids: the message reaches the user's checklist.
  return { known: true, message: `Fresh install: finish onboarding in the browser (${state.pending.length} of ${state.steps.length} steps remain)` };
}

/**
 * Reads the status view until Core answers it: through the landing page, and
 * through the moment between the landing page stopping and Core listening,
 * when nothing answers. Returns the guest's last answer, or the last error
 * when it never answered. Each pass moves the progress bar; that write is
 * refused once the attempt has ended, which ends the wait with it.
 */
async function readWhenCoreAnswers(ctx: VMHookContext, started: number): Promise<VMHookResponse | { error: string }> {
  let answer: VMHookResponse | undefined;
  let error = "";
  let waiting = false;
  for (;;) {
    try {
      answer = await ctx.fetch(ONBOARDING_PATH, { timeoutMs: CORE_READ_TIMEOUT_MS });
      if (!isLandingPage(answer)) return answer;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message !== error) ctx.log(`Home Assistant onboarding read got no answer: ${message}`);
      error = message;
    }
    const elapsed = performance.now() - started;
    if (elapsed + CORE_WAIT_INTERVAL_MS + CORE_READ_TIMEOUT_MS > CORE_WAIT_BUDGET_MS) return answer ?? { error };
    if (!waiting) {
      waiting = true;
      await ctx.updateCheckpointMessage("onboarding", "Waiting for Home Assistant to finish preparing");
    }
    await ctx.setProgress(50 + (45 * elapsed) / CORE_WAIT_BUDGET_MS);
    await ctx.sleep(CORE_WAIT_INTERVAL_MS);
  }
}

export async function run(ctx: VMHookContext): Promise<void> {
  const started = performance.now();
  await ctx.registerCheckpoints([
    { id: "reachable", message: "Confirming Home Assistant answers" },
    { id: "onboarding", message: "Reading onboarding state" },
  ]);

  // Reachability first, on a path every Home Assistant serves: the front page
  // answers whether or not onboarding is done (a fresh install redirects to
  // its onboarding page, which the platform follows on the declared ports),
  // and the landing page answers it too.
  const front = await ctx.waitForApp(ROOT_PATH, { maxAttempts: REACHABLE_ATTEMPTS });
  await ctx.emitCheckpoint("reachable", `Home Assistant answered at ${front.url}`, 50);

  // Then the read that carries the state, once Core answers it, recorded only
  // as far as it goes.
  const status = await readWhenCoreAnswers(ctx, started);
  const described = "error" in status ? NO_ANSWER : describeOnboarding(status);
  ctx.log(`Home Assistant onboarding: ${described.message}`);
  if (described.known) await ctx.emitCheckpoint("onboarding", described.message);
  else await ctx.skipCheckpoint("onboarding", described.message);
}
