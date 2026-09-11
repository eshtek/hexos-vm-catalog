// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of a schema from the hexOS platform monorepo:
//   packages/shared/eshtek/vm-blueprint-tests.ts
//
// That file is the single source of truth. This repo keeps a copy rather than
// importing it because hexos-platform is private and this repo is public: CI
// here runs on fork pull requests, so it cannot depend on a package it has no
// credentials to install.
//
// Re-vendor after any upstream schema change:
//   bun run sync-schema        # wraps _lib/sync-schema.sh
//
// If this copy drifts from upstream it only produces false local results — the
// catalog sync in hexos-platform re-validates every document with the real
// schema at read time, so the server is always the authoritative gate.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// VM blueprint test status, specs and sweep results.
//
// Vendored VERBATIM into the public hexos-vm-catalog repo (its _lib/sync-schema.sh
// copies this file next to the blueprint schema) so the catalog's `_tests/` specs
// validate against the same rules the platform enforces. It must therefore import
// nothing but zod — no platform modules, no node built-ins — which is also why the
// digest below is a self-contained SHA-256 rather than node:crypto or the Web
// Crypto API (the vendored copy typechecks with neither lib guaranteed).
//
// The design in one line: SPECS live in the catalog repo (source, reviewed with the
// blueprint they test), RESULTS live on the main server (observations, append-only,
// queryable as a time series), and console FRAMES are stored as evidence the admin
// UI renders — a 🟡 installed greeter and a 🔴 live installer both report
// `COMPLETED`; only the frame tells them apart.

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Computed from evidence, never hand-set:
 *  - `confirmed`   installs AND readiness was actively observed (task COMPLETED,
 *                  networkConfirmed, a guest IP, non-blank console frame)
 *  - `unmonitored` genuinely installs and reaches a login screen, but readiness
 *                  is unobservable (soft-complete with an installed system on
 *                  the frame)
 *  - `broken`      no usable installed system (FAILED / TIMEOUT, or a
 *                  soft-complete whose frame shows an installer, a live session
 *                  or an unconfigured host)
 * Yellow vs red on a soft-complete is a HUMAN call on the frame; the automated
 * rule records `unmonitored` for any non-blank soft-complete and a reviewer
 * overrides it (`reviewedStatus`).
 */
export const VM_BLUEPRINT_TEST_STATUSES = ['confirmed', 'unmonitored', 'broken'] as const;
export type VMBlueprintTestStatus = (typeof VM_BLUEPRINT_TEST_STATUSES)[number];

/** What the UI shows: a real status, or `untested` (no result, or a stale one). */
export type VMBlueprintTestDisplayStatus = VMBlueprintTestStatus | 'untested';

/** Higher is better. Used for regressions (rank went down) and the worst-across-boxes rollup. */
export const VM_BLUEPRINT_TEST_STATUS_RANK: Record<VMBlueprintTestStatus, number> = {
    confirmed: 3,
    unmonitored: 2,
    broken: 1,
};

/**
 * The blueprint's headline is the WORST box. `untested` sits between broken and
 * unmonitored: a box with no fresh result is not evidence of anything, so one
 * green box never makes the headline green (the 2026-08-08 xubuntu lesson), but
 * a known-broken box still outranks "nobody looked".
 */
const ROLLUP_RANK: Record<VMBlueprintTestDisplayStatus, number> = {
    broken: 0,
    untested: 1,
    unmonitored: 2,
    confirmed: 3,
};

export function rollupTestStatus(statuses: VMBlueprintTestDisplayStatus[]): VMBlueprintTestDisplayStatus {
    if (statuses.length === 0) return 'untested';
    let worst: VMBlueprintTestDisplayStatus = 'confirmed';
    for (const s of statuses) {
        if (ROLLUP_RANK[s] < ROLLUP_RANK[worst]) worst = s;
    }
    return worst;
}

export type VMBlueprintTestTransition = 'improved' | 'regressed' | 'same';

export function testStatusTransition(
    previous: VMBlueprintTestStatus | null | undefined,
    current: VMBlueprintTestStatus,
): VMBlueprintTestTransition | null {
    if (!previous) return null;
    const from = VM_BLUEPRINT_TEST_STATUS_RANK[previous];
    const to = VM_BLUEPRINT_TEST_STATUS_RANK[current];
    return to > from ? 'improved' : to < from ? 'regressed' : 'same';
}

// ─── Functional digest ───────────────────────────────────────────────────────

/**
 * The blueprint fields that can change install behaviour. A result records the
 * digest of exactly these, so a later edit to any of them marks the result
 * stale (⚪ untested) while prose edits — name, description, icon, category,
 * screenshots, website — never expire a 9-hour matrix (the 2026-08-25 copy pass
 * rewrote every description; that must not invalidate anything).
 */
export const VM_BLUEPRINT_FUNCTIONAL_FIELDS = [
    'provisioning',
    'guest',
    'resources',
    'requiredCapabilities',
    'truenasVersion',
    'cpuFeatures',
] as const;

/** Canonical JSON: keys sorted recursively, no whitespace, `undefined` members dropped. */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

export function functionalProjection(document: Record<string, unknown>): string {
    const projected: Record<string, unknown> = {};
    for (const field of VM_BLUEPRINT_FUNCTIONAL_FIELDS) {
        if (document[field] !== undefined) projected[field] = document[field];
    }
    return stableStringify(projected);
}

export const FUNCTIONAL_DIGEST_PREFIX = 'sha256:';
export const FUNCTIONAL_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `sha256:<hex>` over the functional projection. Pure and synchronous everywhere. */
export function functionalDigest(document: Record<string, unknown>): string {
    return FUNCTIONAL_DIGEST_PREFIX + sha256Hex(functionalProjection(document));
}

// Self-contained SHA-256 (FIPS 180-4). Inputs here are ~1-2 KB blueprint
// projections, so a straightforward implementation is plenty; correctness is
// pinned against node:crypto in the backend test suite.
const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
];

function utf8Bytes(text: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                i++;
            }
        }
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        else
            out.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
    }
    return out;
}

export function sha256Hex(text: string): string {
    const bytes = utf8Bytes(text);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 64-bit big-endian length; inputs are far below 2^32 bits but write both halves anyway.
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
    bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);
    // Typed arrays keep every index a plain number under noUncheckedIndexedAccess.
    const input = Uint8Array.from(bytes);
    const w = new Uint32Array(64);
    const k = Uint32Array.from(K);
    const h = Uint32Array.from([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

    for (let offset = 0; offset < input.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] = ((input[j]! << 24) | (input[j + 1]! << 16) | (input[j + 2]! << 8) | input[j + 3]!) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const w15 = w[i - 15]!;
            const w2 = w[i - 2]!;
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
        }
        let a = h[0]!;
        let b = h[1]!;
        let c = h[2]!;
        let d = h[3]!;
        let e = h[4]!;
        let f = h[5]!;
        let g = h[6]!;
        let hh = h[7]!;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + k[i]! + w[i]!) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0]! + a) >>> 0;
        h[1] = (h[1]! + b) >>> 0;
        h[2] = (h[2]! + c) >>> 0;
        h[3] = (h[3]! + d) >>> 0;
        h[4] = (h[4]! + e) >>> 0;
        h[5] = (h[5]! + f) >>> 0;
        h[6] = (h[6]! + g) >>> 0;
        h[7] = (h[7]! + hh) >>> 0;
    }
    return Array.from(h, (v) => v.toString(16).padStart(8, '0')).join('');
}

// ─── Specs (hexos-vm-catalog/_tests) ─────────────────────────────────────────

export const VM_PROVISIONING_STRATEGIES = [
    'image',
    'cloud-init',
    'answer-file',
    'installer-iso',
    'installer-image',
    'machine-config',
] as const;
export type VMProvisioningStrategy = (typeof VM_PROVISIONING_STRATEGIES)[number];
const strategySchema = z.enum(VM_PROVISIONING_STRATEGIES);

/** Box keys are short upper-case identifiers ("AMDHW", "INTEL"); labels carry the human name. */
export const VM_TEST_BOX_KEY_PATTERN = /^[A-Z][A-Z0-9_-]{1,31}$/;
const boxKeySchema = z.string().regex(VM_TEST_BOX_KEY_PATTERN, 'upper-case box key');

const blueprintIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, 'lowercase blueprint id');

export const vmBlueprintTestBoxSchema = z.strictObject({
    key: boxKeySchema,
    label: z.string().min(1).max(64),
    /** The TrueNAS train the box runs, for the per-box mini badge ("TN26", "25.10"). */
    truenasTrain: z.string().min(1).max(32),
});

/**
 * `_tests/suite.json` — the run-wide settings every spec inherits. Secrets never
 * appear here: `passwordEnv` NAMES the environment variable the harness reads
 * the throwaway guest password from.
 */
export const vmBlueprintTestSuiteSchema = z.strictObject({
    schemaVersion: z.literal(1),
    boxes: z.array(vmBlueprintTestBoxSchema).min(1).max(8),
    /** Throwaway guest account name every spec installs with. */
    username: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase account name'),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'environment variable name'),
    /**
     * Wall-clock ceiling per strategy, minutes — above the pipeline's own
     * readiness timeout so a soft-complete is recorded as the pipeline's verdict,
     * never as the harness giving up first.
     */
    ceilingMinutes: z.record(strategySchema, z.number().int().min(5).max(240)),
    /** Rendered by renderVMTestPrompt; {{placeholders}} listed in VM_TEST_PROMPT_PLACEHOLDERS. */
    promptTemplate: z.string().min(1).max(4000),
});
export type VMBlueprintTestSuite = z.infer<typeof vmBlueprintTestSuiteSchema>;

/** The seed device the harness expects to see attached while the guest boots (assertion B). */
export const vmBlueprintTestSeedExpectationSchema = z.strictObject({
    dtype: z.enum(['RAW', 'CDROM']),
    order: z.number().int().min(1).max(9),
    /** ISO-9660 volume label of a RAW seed ("cidata", "config-2"); CDROM seeds carry none worth asserting. */
    label: z.string().max(32).optional(),
});

/**
 * `_tests/spec/<blueprintId>.json` — how to test ONE blueprint and what to
 * assert. Deliberately small: everything derivable from the blueprint document
 * (strategy, disk bus, readiness type) is derived at run time so the spec cannot
 * drift from the blueprint; what lives here is the install OPTIONS shape, the
 * per-blueprint ceiling, which optional assertions apply, and reviewer guidance.
 */
export const vmBlueprintTestSpecSchema = z.strictObject({
    blueprintId: blueprintIdSchema,
    strategy: strategySchema,
    /**
     * Which install-dialog answers the harness supplies. Booleans, never values:
     * the username comes from suite.json, the password from the environment,
     * and a user-supplied ISO from the box config (`userIso` marks the
     * answer-file blueprints that need one).
     */
    options: z.strictObject({
        username: z.boolean(),
        password: z.boolean(),
        userIso: z.boolean(),
    }),
    /** Overrides the suite's per-strategy ceiling for this blueprint. */
    ceilingMinutes: z.number().int().min(5).max(240).optional(),
    checks: z.strictObject({
        /** Assertion D/G: read the STOPPED guest's disk offline (hostname, accounts, cloud-init datasource). */
        guestRead: z.boolean(),
        /** Assertion G: stop/start steady state (same hostname, no re-provision, non-blank frame). */
        reboot: z.boolean(),
        /** Assertion B/C; null for blueprints that carry answers inside the installer copy (no seed volume). */
        seed: vmBlueprintTestSeedExpectationSchema.nullable(),
    }),
    /** What a reviewer should look for on the console frame when deciding 🟡 vs 🔴 for a soft-complete. */
    frameReview: z.string().max(500).optional(),
    /** A known, accepted limitation ("never phones home; SDDM greeter is the pass condition"). */
    knownIssue: z.string().max(500).optional(),
});
export type VMBlueprintTestSpec = z.infer<typeof vmBlueprintTestSpecSchema>;

// ─── Results (submitted by the harness, stored on main) ──────────────────────

const hex64 = z.string().regex(/^[a-f0-9]{64}$/, 'sha256 hex');
const gitSha = z.string().regex(/^[a-f0-9]{7,40}$/, 'git commit');

export const vmBlueprintTestStepSchema = z.strictObject({
    id: z.string().min(1).max(32),
    status: z.string().min(1).max(16),
    progress: z.number().min(0).max(100).optional(),
});

/** Measured, never inferred from file size: a text console and a black frame compress alike. */
export const vmBlueprintTestFrameMetaSchema = z.strictObject({
    sha256: hex64,
    bytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1024 * 1024),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    /** Fraction of sampled pixels brighter than the threshold (0 = black, 1 = all lit). */
    lit: z.number().min(0).max(1),
    /** Luminance mean / spread, 0-255. Low spread means nothing is drawn, dark OR bright. */
    mean: z.number().min(0).max(255),
    stddev: z.number().min(0).max(255),
    blank: z.boolean(),
});
export type VMBlueprintTestFrameMeta = z.infer<typeof vmBlueprintTestFrameMetaSchema>;

export const VM_TEST_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/;
export const VM_TEST_DOCUMENT_MAX_BYTES = 32 * 1024;

/**
 * One blueprint × box × attempt. An explicit allowlist of the install task's
 * fields — never the raw task `data` blob, which carries the phone-home token.
 */
export const vmBlueprintTestResultSubmissionSchema = z.strictObject({
    blueprintId: blueprintIdSchema,
    /** 1 for the sweep pass; 2+ for intermittency repeats of the same blueprint in the same run. */
    runNumber: z.number().int().min(1).max(20).default(1),
    strategy: strategySchema,
    status: z.enum(VM_BLUEPRINT_TEST_STATUSES),
    /** Reviewer's call on the frame, when it disagrees with the automated status. */
    reviewedStatus: z.enum(VM_BLUEPRINT_TEST_STATUSES).nullable().optional(),
    reviewNote: z.string().max(500).nullable().optional(),
    verdict: z.string().min(1).max(32),
    phase: z.string().max(32).nullable(),
    seconds: z
        .number()
        .int()
        .min(0)
        .max(24 * 3600),
    totalSeconds: z
        .number()
        .int()
        .min(0)
        .max(24 * 3600),
    guestIp: z.string().max(45).nullable(),
    networkConfirmed: z.boolean().nullable(),
    errorCode: z.string().max(64).nullable(),
    errorDetail: z.string().max(2000).nullable(),
    steps: z.array(vmBlueprintTestStepSchema).max(16),
    /** Assertion outcomes A-H, flattened ("seedAligned": true); null = not applicable. */
    checks: z.record(z.string().regex(/^[a-zA-Z0-9_:.-]{1,48}$/), z.boolean().nullable()),
    /** The one-line evidence string the report renders ("seed=RAW/VIRTIO … host=e2e-debian-12 …"). */
    evidence: z.string().max(1000),
    retried: z.boolean().default(false),
    /**
     * The blueprint document the box actually installed from (its own synced
     * copy). The server derives the functional digest from THIS, so a result
     * always records what it observed even if the catalog moved on since.
     */
    document: z
        .record(z.string(), z.unknown())
        .refine((d) => JSON.stringify(d).length <= VM_TEST_DOCUMENT_MAX_BYTES, 'document too large'),
    frame: vmBlueprintTestFrameMetaSchema.nullable(),
    rebootFrame: vmBlueprintTestFrameMetaSchema.nullable(),
    startedAt: z.iso.datetime({ offset: true }),
});
export type VMBlueprintTestResultSubmission = z.infer<typeof vmBlueprintTestResultSubmissionSchema>;

export const VM_TEST_RUN_MAX_RESULTS = 128;

/**
 * One box's share of a sweep. Idempotent on (runId, box, blueprintId, runNumber):
 * a resumed or re-submitted sweep overwrites its own rows and never double-counts.
 * Frames are uploaded separately (PUT …/frames), keyed the same way.
 */
export const vmBlueprintTestRunSubmissionSchema = z.strictObject({
    runId: z.string().regex(VM_TEST_RUN_ID_PATTERN, 'run id'),
    box: boxKeySchema,
    boxLabel: z.string().max(64).optional(),
    truenasVersion: z.string().max(32).optional(),
    /** The hexos-platform commit the box ran (the dev runner deploys the checkout). */
    platformTestKey: gitSha.optional(),
    platformRef: z.string().max(128).optional(),
    /** The catalog branch/ref and commit the blueprints were synced from. */
    catalogRef: z.string().max(128).optional(),
    catalogCommit: gitSha.optional(),
    harnessVersion: z.string().max(32).optional(),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }).optional(),
    results: z.array(vmBlueprintTestResultSubmissionSchema).min(1).max(VM_TEST_RUN_MAX_RESULTS),
});
export type VMBlueprintTestRunSubmission = z.infer<typeof vmBlueprintTestRunSubmissionSchema>;

export const vmBlueprintTestReviewSchema = z.strictObject({
    /** null clears the override and the automated status stands again. */
    reviewedStatus: z.enum(VM_BLUEPRINT_TEST_STATUSES).nullable(),
    reviewNote: z.string().max(500).nullable().optional(),
});
export type VMBlueprintTestReview = z.infer<typeof vmBlueprintTestReviewSchema>;

export const VM_TEST_FRAME_KINDS = ['final', 'reboot'] as const;
export type VMBlueprintTestFrameKind = (typeof VM_TEST_FRAME_KINDS)[number];
/** PNG frames are small (a 1024×768 console frame is ~4-300 KB); this is a hard cap, not a target. */
export const VM_TEST_FRAME_MAX_BYTES = 2 * 1024 * 1024;

// ─── Records (what the admin API serves) ─────────────────────────────────────

export interface VMBlueprintTestResultRecord {
    id: number;
    runId: string;
    box: string;
    blueprintId: string;
    runNumber: number;
    strategy: VMProvisioningStrategy;
    /** Automated status from the evidence rule. */
    status: VMBlueprintTestStatus;
    reviewedStatus: VMBlueprintTestStatus | null;
    reviewNote: string | null;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    /** reviewedStatus when set, else status — what every rollup uses. */
    effectiveStatus: VMBlueprintTestStatus;
    verdict: string;
    phase: string | null;
    seconds: number;
    totalSeconds: number;
    guestIp: string | null;
    networkConfirmed: boolean | null;
    errorCode: string | null;
    errorDetail: string | null;
    steps: z.infer<typeof vmBlueprintTestStepSchema>[];
    checks: Record<string, boolean | null>;
    evidence: string;
    retried: boolean;
    functionalDigest: string;
    platformTestKey: string | null;
    frame: VMBlueprintTestFrameMeta | null;
    rebootFrame: VMBlueprintTestFrameMeta | null;
    /** True once the PNG bytes were uploaded; the meta alone comes with the submission. */
    hasFrame: boolean;
    hasRebootFrame: boolean;
    startedAt: Date;
    createdAt: Date;
}

export interface VMBlueprintTestRunRecord {
    runId: string;
    boxes: string[];
    platformTestKey: string | null;
    platformRef: string | null;
    catalogRef: string | null;
    catalogCommit: string | null;
    harnessVersion: string | null;
    submittedBy: string | null;
    startedAt: Date;
    finishedAt: Date | null;
    resultCount: number;
    counts: Record<VMBlueprintTestStatus, number>;
    createdAt: Date;
    updatedAt: Date;
}

/** Latest observation of one blueprint on one box, with the transition from the one before. */
export interface VMBlueprintBoxTestStatus {
    box: string;
    status: VMBlueprintTestDisplayStatus;
    /** The underlying observation, even when `status` reads `untested` because it went stale. */
    latest: {
        resultId: number;
        runId: string;
        status: VMBlueprintTestStatus;
        startedAt: Date;
        totalSeconds: number;
        guestIp: string | null;
        functionalDigest: string;
        platformTestKey: string | null;
        hasFrame: boolean;
        reviewed: boolean;
    } | null;
    /** True when the latest result tested a different functional document than the catalog holds now. */
    stale: boolean;
    previous: { resultId: number; runId: string; status: VMBlueprintTestStatus; startedAt: Date } | null;
    transition: VMBlueprintTestTransition | null;
}

export const VM_TEST_NEEDS_TESTING_REASONS = [
    'never-tested',
    'stale-document',
    'not-confirmed',
    'regressed',
    'upstream-changed',
] as const;
export type VMBlueprintNeedsTestingReason = (typeof VM_TEST_NEEDS_TESTING_REASONS)[number];

export interface VMBlueprintTestStatusRecord {
    blueprintId: string;
    strategy: VMProvisioningStrategy | null;
    /** Digest of the document the catalog holds NOW (override applied) — what a fresh result must match. */
    currentDigest: string | null;
    rollup: VMBlueprintTestDisplayStatus;
    stale: boolean;
    boxes: VMBlueprintBoxTestStatus[];
    /** When the rollup last changed (the newest result whose transition was not `same`). */
    changedAt: Date | null;
    needsTesting: VMBlueprintNeedsTestingReason[];
    upstream: VMBlueprintUpstreamCheckRecord | null;
}

export interface VMBlueprintTestStatusCounts {
    confirmed: number;
    unmonitored: number;
    broken: number;
    untested: number;
    stale: number;
    regressed: number;
    needsTesting: number;
}

export interface AdminVMBlueprintTestStatusResponse {
    blueprints: VMBlueprintTestStatusRecord[];
    boxes: string[];
    counts: VMBlueprintTestStatusCounts;
    latestRun: VMBlueprintTestRunRecord | null;
}

export interface AdminVMBlueprintTestRunsResponse {
    runs: VMBlueprintTestRunRecord[];
    total: number;
}

export interface VMBlueprintTestRunTransition {
    blueprintId: string;
    box: string;
    from: VMBlueprintTestStatus | null;
    to: VMBlueprintTestStatus;
    transition: VMBlueprintTestTransition | null;
}

export interface AdminVMBlueprintTestRunDetailResponse {
    run: VMBlueprintTestRunRecord;
    results: VMBlueprintTestResultRecord[];
    /** Every (blueprint, box) in this run against the previous observation of the same pair. */
    transitions: VMBlueprintTestRunTransition[];
}

export interface AdminVMBlueprintTestHistoryResponse {
    blueprintId: string;
    results: VMBlueprintTestResultRecord[];
}

export interface AdminVMBlueprintTestSubmitResponse {
    runId: string;
    box: string;
    inserted: number;
    updated: number;
}

// ─── Trigger A: upstream version watcher ─────────────────────────────────────

/**
 * Vendor release pages are read weekly at most, with conditional requests, and
 * only ever compared as CONTENT HASHES — parsing a version out of an arbitrary
 * vendor page is fragile, and the failure mode of a parser is a false "up to
 * date". A changed page is a prompt for a maintainer to look, never a claim
 * about what changed.
 */
export type VMBlueprintUpstreamCheckState = 'unchecked' | 'unchanged' | 'changed' | 'unreachable' | 'acknowledged';

export interface VMBlueprintUpstreamCheckRecord {
    blueprintId: string;
    releasesUrl: string;
    state: VMBlueprintUpstreamCheckState;
    /** The pinned source version at the time of the last check, so a bump resets the comparison. */
    pinnedVersion: string | null;
    checkedAt: Date | null;
    changedAt: Date | null;
    acknowledgedAt: Date | null;
    httpStatus: number | null;
    error: string | null;
}

// ─── Trigger B: platform change → affected blueprints ────────────────────────

export interface VMPlatformImpactRule {
    /** Repo-relative path prefix or exact file. */
    path: string;
    /** `all`, or a predicate over the blueprint document. */
    affects: 'all' | 'seeded' | 'first-boot' | { strategies: VMProvisioningStrategy[] };
    reason: string;
}

/**
 * The shared install pipeline, declared. Per-strategy renderers map to the
 * strategies that name them; the pure planning layer and the interface touch
 * everything. Keep this list next to the code it describes — a new renderer
 * file that is missing here is invisible to the CI check.
 */
export const VM_PLATFORM_IMPACT_RULES: VMPlatformImpactRule[] = [
    {
        path: 'packages/backend/src/lib/cloudInitSeed.ts',
        affects: { strategies: ['cloud-init'] },
        reason: 'cloud-init user-data templates',
    },
    {
        path: 'packages/backend/src/lib/installerSeed.ts',
        affects: { strategies: ['installer-iso', 'installer-image'] },
        reason: 'installer seed templates',
    },
    {
        path: 'packages/backend/src/lib/machineConfigSeed.ts',
        affects: { strategies: ['machine-config'] },
        reason: 'machine-config (Ignition) templates',
    },
    {
        path: 'packages/backend/src/lib/autounattend.ts',
        affects: { strategies: ['answer-file'] },
        reason: 'Windows unattend rendering',
    },
    {
        path: 'packages/backend/src/lib/iso9660.ts',
        affects: 'seeded',
        reason: 'seed image builder (every seeded strategy)',
    },
    {
        path: 'packages/backend/src/lib/vmFirstBoot.ts',
        affects: 'first-boot',
        reason: 'first-boot profiles written into the image',
    },
    { path: 'packages/backend/src/lib/vmInstallPlan.ts', affects: 'all', reason: 'install planning layer' },
    { path: 'packages/backend/src/lib/vmProvision.ts', affects: 'all', reason: 'provisioning pipeline' },
    { path: 'packages/backend/src/lib/vmGuestBoot.ts', affects: 'all', reason: 'guest boot/readiness tracking' },
    { path: 'packages/backend/src/interface/vms.ts', affects: 'all', reason: 'VM interface (install pipeline)' },
    { path: 'packages/shared/eshtek/vm-blueprints.ts', affects: 'all', reason: 'blueprint schema' },
];

export interface VMBlueprintImpact {
    blueprintId: string;
    reasons: string[];
}

interface ImpactBlueprint {
    blueprintId: string;
    document: Record<string, unknown> | null;
}

function ruleApplies(rule: VMPlatformImpactRule, document: Record<string, unknown> | null): boolean {
    if (rule.affects === 'all') return true;
    const provisioning = (document?.provisioning ?? null) as Record<string, unknown> | null;
    const strategy = provisioning?.strategy as VMProvisioningStrategy | undefined;
    if (!strategy) return false;
    if (rule.affects === 'seeded') return strategy !== 'image';
    if (rule.affects === 'first-boot') return Boolean(provisioning?.firstBoot);
    return rule.affects.strategies.includes(strategy);
}

/** Which blueprints a set of changed platform paths can flip, with the reason per blueprint. */
export function affectedBlueprintsForPaths(changedPaths: string[], blueprints: ImpactBlueprint[]): VMBlueprintImpact[] {
    const matched = VM_PLATFORM_IMPACT_RULES.filter((rule) =>
        changedPaths.some((p) => p === rule.path || p.startsWith(`${rule.path}/`)),
    );
    if (matched.length === 0) return [];
    const out: VMBlueprintImpact[] = [];
    for (const bp of blueprints) {
        const reasons = matched
            .filter((rule) => ruleApplies(rule, bp.document))
            .map((rule) => `${rule.path} — ${rule.reason}`);
        if (reasons.length) out.push({ blueprintId: bp.blueprintId, reasons });
    }
    return out;
}

// ─── Clipboard prompt ────────────────────────────────────────────────────────

/** The catalog's `_tests/suite.json` as main last read it; `suite` is null when it is absent or invalid. */
export interface AdminVMBlueprintTestSuiteResponse {
    suite: VMBlueprintTestSuite | null;
    /** Where it was read from ("local:<path>" in dev, "github:<branch>" otherwise). */
    source: string;
    error: string | null;
    fetchedAt: Date;
}

/** Used when the catalog's suite.json cannot be read — the same shape, shorter. */
export const VM_TEST_DEFAULT_PROMPT_TEMPLATE =
    'Run the VM catalog sweep for: {{blueprints}}\nBoxes: {{boxes}}\nCatalog: eshtek/hexos-vm-catalog @ {{catalogRef}} (specs in _tests/). Platform: eshtek/hexos-platform @ {{platformRef}}.\nWhy: {{reason}}\n\nUse packages/dev/scripts/vm-catalog-sweep (plan.py --catalog, one sweep.py per box with a shared --run-id, review soft-completes into reviewed.json, submit.py per box). Results appear at {{resultsUrl}}. Never park a blueprint automatically.';

export const VM_TEST_PROMPT_PLACEHOLDERS = [
    'blueprints',
    'boxes',
    'catalogRef',
    'platformRef',
    'resultsUrl',
    'reason',
] as const;

export function renderVMTestPrompt(
    template: string,
    vars: Partial<Record<(typeof VM_TEST_PROMPT_PLACEHOLDERS)[number], string>>,
): string {
    return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key: string) => {
        const value = vars[key as (typeof VM_TEST_PROMPT_PLACEHOLDERS)[number]];
        return value === undefined ? match : value;
    });
}

// ─── Sweep evidence on GitHub (commit statuses posted by submit.py) ──────────
//
// Results live on main behind admin auth, where a CI runner cannot reach them.
// What a PR check needs is only "did a sweep run against this pipeline code,
// and how did it go" — so the harness, run by an engineer, posts one commit
// status per box on the platform commit it tested, and the impact workflow
// reads statuses back with the plain GITHUB_TOKEN (works on fork PRs, no
// service account). GitHub caps a status description at 140 characters, hence
// the compact grammar below; the full per-blueprint record stays on main.

export const VM_SWEEP_STATUS_CONTEXT_PREFIX = 'vm-sweep/';
export const VM_SWEEP_STATUS_DESCRIPTION_MAX = 140;
export const VM_SWEEP_IMPACT_DIGEST_CHARS = 12;

/** One `path → git object id` pair; `oid` is null when the path is absent at that commit. */
export interface VMPlatformImpactEntry {
    path: string;
    oid: string | null;
}

/**
 * Digest of the install pipeline's CONTENT at a commit: the git object ids of
 * every VM_PLATFORM_IMPACT_RULES path (a tree id already digests a directory).
 * Two commits with equal digests ship the same pipeline code, so a sweep of one
 * counts for the other — a rebase or a docs-only commit never invalidates a
 * sweep, while a base branch that touched the pipeline does.
 */
export function platformImpactDigest(entries: VMPlatformImpactEntry[]): string {
    const lines = [...entries]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((entry) => `${entry.path}\0${entry.oid ?? 'missing'}`);
    return sha256Hex(lines.join('\n'));
}

export interface VMSweepStatusSummary {
    runId: string;
    /** Blueprints the sweep tested (last attempt per blueprint). */
    tested: number;
    /** True when every shippable (non-internal) blueprint in the catalog was tested. */
    full: boolean;
    confirmed: number;
    unmonitored: number;
    broken: number;
    /** The tested ids when the harness could list them; null when unknown or truncated. */
    testedIds: string[] | null;
    /** The broken ids; `[]` when nothing broke, null when unknown or truncated. */
    brokenIds: string[] | null;
    /** First VM_SWEEP_IMPACT_DIGEST_CHARS hex of platformImpactDigest at the tested commit, when recorded. */
    impactDigest: string | null;
}

function parseIdList(text: string): string[] | null {
    // "a,b,c" or "a,b +N" — the "+N" means ids were dropped to fit, so the list is unknown.
    const match = text.trim().match(/^(\S+?)(?: \+(\d+))?$/);
    if (!match || match[2] !== undefined) return null;
    const ids = (match[1] as string).split(',').filter(Boolean);
    return ids.length ? ids : null;
}

/**
 * Parses a `vm-sweep/<box>` status description. Grammar (parts joined by " · "):
 *   <runId> · <n> tested[ (full)] · <n> ok · <n> unmonitored · <n> broken[: id,id[ +N]] [· tested: id,id[ +N]] [· impact:<12 hex>]
 * Unknown parts are ignored so the harness can add detail without breaking readers.
 */
export function parseVMSweepStatusDescription(description: string): VMSweepStatusSummary | null {
    const parts = description.split(' · ').map((part) => part.trim());
    const runId = parts[0];
    const tested = parts[1]?.match(/^(\d+) tested( \(full\))?$/);
    if (!runId || !tested) return null;
    const summary: VMSweepStatusSummary = {
        runId,
        tested: Number(tested[1]),
        full: tested[2] !== undefined,
        confirmed: 0,
        unmonitored: 0,
        broken: 0,
        testedIds: null,
        brokenIds: null,
        impactDigest: null,
    };
    for (const part of parts.slice(2)) {
        const ok = part.match(/^(\d+) ok$/);
        const unmonitored = part.match(/^(\d+) unmonitored$/);
        const broken = part.match(/^(\d+) broken(?:: (.+))?$/);
        const tested = part.match(/^tested: (.+)$/);
        const impact = part.match(/^impact:([a-f0-9]{12})$/);
        if (ok) summary.confirmed = Number(ok[1]);
        else if (unmonitored) summary.unmonitored = Number(unmonitored[1]);
        else if (broken) {
            summary.broken = Number(broken[1]);
            summary.brokenIds = summary.broken === 0 ? [] : broken[2] ? parseIdList(broken[2]) : null;
        } else if (tested) summary.testedIds = parseIdList(tested[1] as string);
        else if (impact) summary.impactDigest = impact[1] as string;
    }
    return summary;
}

/** A `vm-sweep/<box>` commit status as read back from GitHub. */
export interface VMSweepStatusEvidence {
    sha: string;
    box: string;
    /** GitHub's state: success | failure | error | pending. */
    state: string;
    description: string;
    targetUrl: string | null;
}

/**
 * exact          — a sweep ran on this very head
 * same-pipeline  — a sweep ran on a commit whose impact digest equals the head's (rebase, docs commit)
 * stale          — the newest sweep found predates the pipeline change
 * none           — no sweep status on any candidate commit
 */
export type VMSweepCoverage = 'exact' | 'same-pipeline' | 'stale' | 'none';

export interface VMSweepBoxVerdict {
    box: string;
    coverage: VMSweepCoverage;
    evidence: VMSweepStatusEvidence | null;
    summary: VMSweepStatusSummary | null;
    /** Affected blueprints no sweep of this pipeline code tested; null when the status could not say which it tested. */
    untestedAffected: string[] | null;
    /** Affected blueprints a sweep of this pipeline code found broken; null when the status listed a truncated set. */
    brokenAffected: string[] | null;
}

export type VMSweepOverallVerdict = 'covered' | 'partial' | 'stale' | 'none';

function coverageOf(
    status: VMSweepStatusEvidence,
    summary: VMSweepStatusSummary | null,
    headSha: string,
    headDigest: string | null,
): VMSweepCoverage {
    if (status.sha === headSha) return 'exact';
    if (summary?.impactDigest && headDigest?.startsWith(summary.impactDigest)) return 'same-pipeline';
    return 'stale';
}

/**
 * Per-box verdict from the statuses found on the candidate commits (newest
 * candidate first). A box's exact match beats a same-pipeline match beats the
 * newest stale one; boxes with no status at all are absent from the result.
 */
export function vmSweepEvidenceForChange(input: {
    headSha: string;
    headDigest: string | null;
    affected: string[];
    statuses: VMSweepStatusEvidence[];
}): VMSweepBoxVerdict[] {
    const rank: Record<VMSweepCoverage, number> = { exact: 3, 'same-pipeline': 2, stale: 1, none: 0 };
    const best = new Map<string, VMSweepBoxVerdict>();
    for (const status of input.statuses) {
        const summary = parseVMSweepStatusDescription(status.description);
        const coverage = coverageOf(status, summary, input.headSha, input.headDigest);
        const current = best.get(status.box);
        if (current && rank[current.coverage] >= rank[coverage]) continue;
        const covers = coverage === 'exact' || coverage === 'same-pipeline';
        let untestedAffected: string[] | null = input.affected;
        let brokenAffected: string[] | null = [];
        if (covers && summary) {
            if (summary.testedIds) untestedAffected = input.affected.filter((id) => !summary.testedIds?.includes(id));
            else if (summary.full) untestedAffected = [];
            else untestedAffected = null;
            brokenAffected = summary.brokenIds ? input.affected.filter((id) => summary.brokenIds?.includes(id)) : null;
        } else if (covers) {
            untestedAffected = null;
            brokenAffected = null;
        }
        best.set(status.box, {
            box: status.box,
            coverage,
            evidence: status,
            summary,
            untestedAffected,
            brokenAffected,
        });
    }
    return [...best.values()].sort((a, b) => (a.box < b.box ? -1 : a.box > b.box ? 1 : 0));
}

export function vmSweepOverallVerdict(verdicts: VMSweepBoxVerdict[]): VMSweepOverallVerdict {
    if (verdicts.length === 0) return 'none';
    const covering = verdicts.filter((v) => v.coverage === 'exact' || v.coverage === 'same-pipeline');
    if (covering.length === 0) return 'stale';
    if (covering.length === verdicts.length && covering.every((v) => v.untestedAffected?.length === 0))
        return 'covered';
    return 'partial';
}
