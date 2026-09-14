/**
 * VMHookContext — the runtime context passed to every VM setup hook entrypoint.
 *
 * MIRROR: this interface is a hand-maintained copy of the public surface of
 * hexos-platform/packages/backend/src/lib/vm/setupContext.ts (class
 * VMHookContext). Update BOTH files when the contract grows — nothing checks
 * this for you. The real object is constructed by the platform when it runs
 * the hook; scripts import this interface for autocompletion and type safety
 * only, and MUST import it as a type: the platform inlines each script at
 * catalog sync and refuses any runtime import (see README, "Setup hooks").
 *
 * Where the script runs, and what it can reach. The script runs in-process on
 * the user's HexOS box (the same runner app hooks use), after the platform has
 * confirmed that the guest's address answers ARP with the VM's own MAC on the
 * network path a request will take. Everything the script sends to the guest
 * goes through `fetch` and `waitForApp`, which are bound to those verified
 * paths; there is no guest execution channel of any kind, and a bare `fetch`
 * would not reach a macvtap guest at all (macvtap isolates guest and host, so
 * the platform reaches the guest through its VM shim, not the box's primary
 * address). A setup hook must never write to a guest it did not install, and
 * it must tolerate a guest a user has already set up by hand.
 *
 * The attempt's end is final. The platform cannot stop a running entrypoint,
 * so once it has ended the attempt (the run was cancelled, the declared
 * timeout passed, or the next declared retry started) every new effect
 * through this context is refused with an error: requests to the guest,
 * checkpoint and progress writes, and secret reads and writes; an operation
 * the context had already admitted still lands, and a checkpoint wait ends
 * with the attempt. A script that is still running after that can compute,
 * but it cannot act. No declared retry follows an attempt whose checkpoint
 * park is unresolved, whether it is still being recorded or waiting on the
 * user: the park is the user's to resolve.
 *
 * @example
 * ```ts
 * import type { VMHookContext } from "../_lib/hook_context";
 *
 * export async function run(ctx: VMHookContext) {
 *   await ctx.registerCheckpoints([{ id: "reachable", message: "Confirming the guest answers" }]);
 *   const response = await ctx.waitForApp("/api/onboarding");
 *   await ctx.emitCheckpoint("reachable", `Answered at ${response.url}`);
 * }
 * ```
 */

/** A request to the guest. Paths are absolute on the guest's declared port. */
export interface VMHookFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Per-request timeout; the platform's default applies otherwise. */
  timeoutMs?: number;
  /** Cap on the response body the platform will buffer. */
  maxBodyBytes?: number;
}

/**
 * The guest's answer, buffered. A redirect to the declared port or an
 * alternate declared port is followed; `url` is the URL that answered, so it
 * names the alternate port (or none, for 80) after such a redirect. This is
 * the script-facing subset of the platform's response: the platform's own
 * object also carries the route it used and the socket's source address,
 * which a script has no business reading.
 */
export interface VMHookResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  text(): string;
  /** Parses the body as JSON; throws when it is not. */
  json(): unknown;
  /** The URL that produced this response, after any redirects. */
  url: string;
  /** Redirects followed. */
  hops: number;
}

/**
 * Credentials the hook collects or mints, kept by the platform for this VM
 * instance (bound to its identity, so a VM recreated under a reused id never
 * inherits them) and removed with the VM or when the user disables the
 * integration. Never put a secret into a checkpoint message or a log line.
 */
export interface VMHookSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Record<string, string>>;
}

export interface WaitForAppOptions {
  /** Expected HTTP status code (default: 200) */
  expectedStatus?: number;
  /** Maximum number of poll attempts (default: 40) */
  maxAttempts?: number;
  /** Initial delay between attempts in ms (default: 5000) */
  initialDelayMs?: number;
  /** Maximum delay between attempts in ms (default: 15000) */
  maxDelayMs?: number;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Additional request headers */
  headers?: Record<string, string>;
}

export interface VMHookContext {
  /** Always "vm". */
  readonly resourceType: "vm";
  /** The HexOS instance UUID: stable across renames, never reused. */
  readonly resourceId: string;
  /** The VM this hook runs for. */
  readonly vm: {
    /** The HexOS instance UUID (the same as resourceId). */
    instanceId: string;
    /** The hypervisor's own UUID for this VM. */
    vmUuid: string;
    /**
     * The VM's name as the platform recorded it when setup was snapshotted
     * at install. Users can rename a VM; a rename is not reflected here.
     */
    name: string;
    /** The blueprint id this VM was installed from. */
    blueprintId: string;
  };
  /** The only lifecycle firing a setup hook receives. */
  readonly event: "onAfterReady";
  /** The guest address the platform verified against the VM's MAC. */
  readonly host: string;
  /** The declared guestPort. */
  readonly port: number;
  /** `${guestScheme}://${host}:${port}` */
  readonly baseUrl: string;
  /**
   * User-collected inputs, keyed by input declaration ID.
   * - OAuth inputs: `{ authToken: string, ... }` (shape depends on provider)
   * - Question inputs: the raw answer value (string | number | boolean)
   */
  readonly inputs: Record<string, unknown>;
  /** No analogue for a VM: a guest's disks are its own. Always empty. */
  readonly mounts: never[];
  readonly secrets: VMHookSecrets;

  /**
   * A request to the guest, on the verified paths only. `path` is absolute on
   * the declared guestPort (e.g. "/api/onboarding"); a redirect may land on
   * a declared alternate port. Rejects when the guest does not answer, when
   * the platform cancels the run, or when the answer arrives from a path the
   * platform did not verify.
   */
  fetch(path: string, init?: VMHookFetchInit): Promise<VMHookResponse>;

  /** Other installed apps are not reachable from a VM setup; always null. */
  getInstalledAppUrl(appId: string): Promise<string | null>;

  /**
   * Type-safe input accessor. Throws if the input is missing; with a schema
   * (anything exposing zod's safeParse), throws when the value fails it.
   */
  getInput<T = unknown>(
    inputId: string,
    schema?: { safeParse(value: unknown): { success: boolean; data?: T; error?: { message: string } } },
  ): T;

  /** Log a message (visible in backend logs, not shown to the user). */
  log(message: string): void;

  /** Async sleep helper. */
  sleep(ms: number): Promise<void>;

  /**
   * Fail the hook with a structured error. The message is shown as the
   * primary error, and context items are rendered as labelled key-value
   * pairs in the UI. An optional hook that fails is skipped; a required one
   * parks the setup until the user retries, skips or dismisses it.
   */
  fail(message: string, context?: Array<{ label: string; value: string }>): never;

  /**
   * Register all checkpoints upfront so the UI shows them as pending from
   * the start. Call this before any async work begins.
   */
  registerCheckpoints(checkpoints: Array<{ id: string; message: string }>): Promise<void>;

  /**
   * Mark a registered checkpoint as completed. If the checkpoint wasn't
   * registered, it's added as completed. Progress auto-calculates from the
   * completed/total ratio unless explicitly provided (0-99).
   */
  emitCheckpoint(id: string, message?: string, progress?: number): Promise<void>;

  /** Update a checkpoint's message without marking it completed. */
  updateCheckpointMessage(id: string, message: string): Promise<void>;

  /** Drive the task's progress bar directly (clamped 0-99) without touching checkpoints. */
  setProgress(percent: number): Promise<void>;

  /** Mark a checkpoint as skipped (distinct from completed). */
  skipCheckpoint(id: string, message?: string): Promise<void>;

  /** The first checkpoint not yet completed, if any. */
  getFailedAtCheckpoint(): string | undefined;

  /**
   * Park the hook at a failed checkpoint and wait for the user to retry or
   * skip it. The error and context are surfaced in the UI exactly like
   * `fail()`, but the hook stays alive and resumes when the user acts. A
   * dismiss reads as "skip"; the wait ends after an hour.
   */
  awaitCheckpointRetry(
    checkpointId: string,
    error: string,
    context?: Array<{ label: string; value: string }>,
  ): Promise<"retry" | "skip">;

  /**
   * Poll a path on the guest until it answers with the expected status, over
   * the verified paths. Rejects after maxAttempts, or when the platform
   * cancels the run.
   */
  waitForApp(path: string, opts?: WaitForAppOptions): Promise<VMHookResponse>;
}
