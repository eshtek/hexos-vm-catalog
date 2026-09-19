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
 */

const ROOT_PATH = "/";
const ONBOARDING_PATH = "/api/onboarding";
/** Attempts at the platform's back-off (5 s growing to 15 s): about six minutes. */
const REACHABLE_ATTEMPTS = 24;

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

/** What the recorded checkpoint says for each thing the status view can establish. */
export function describeOnboarding(response: Pick<VMHookResponse, "status"> & { json(): unknown }): {
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

export async function run(ctx: VMHookContext): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "reachable", message: "Confirming Home Assistant answers" },
    { id: "onboarding", message: "Reading onboarding state" },
  ]);

  // Reachability first, on a path every Home Assistant serves: the front page
  // answers whether or not onboarding is done (a fresh install redirects to
  // its onboarding page, which the platform follows on the declared ports).
  const front = await ctx.waitForApp(ROOT_PATH, { maxAttempts: REACHABLE_ATTEMPTS });
  await ctx.emitCheckpoint("reachable", `Home Assistant answered at ${front.url}`, 50);

  // Then the one read that carries the state, recorded only as far as it goes.
  const status = await ctx.fetch(ONBOARDING_PATH);
  const described = describeOnboarding(status);
  ctx.log(`Home Assistant onboarding: ${described.message}`);
  if (described.known) await ctx.emitCheckpoint("onboarding", described.message);
  else await ctx.skipCheckpoint("onboarding", described.message);
}
