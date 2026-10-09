// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of a schema from the hexOS platform monorepo:
//   packages/shared/eshtek/surface-grammar.ts
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

// Leaf contracts shared by every surface grammar: the app dictionary's v6
// hooks and widgets (installScript.ts, widgets.ts, hooks.ts) and the VM
// blueprint's hooks and widgets (vm-surfaces.ts). A field the two grammars
// share has one definition here, so a change reaches both.
//
// Zod and nothing else. The VM catalog vendors this file verbatim beside
// vm-surfaces.ts (the same arrangement as vm-blueprints.ts), so an import of
// any other platform module here would break the catalog's local validation.
// The app grammar's closed enums and its refinements stay in installScript.ts.

// ===== Inputs (collected from the user before a script runs) =====

const questionSchema = z.object({
    question: z.string().min(1),
    type: z.enum(['text', 'number', 'select', 'boolean', 'password']),
    key: z.string().min(1),
    options: z.array(z.object({ text: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    placeholder: z.string().optional(),
    description: z.string().optional(),
});

const oauthPinFlowSchema = z.object({
    type: z.literal('pin'),
    pinUrl: z.url(),
    authUrl: z.string().min(1),
    pollUrl: z.string().min(1),
    clientId: z.string().min(1),
    tokenField: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
});

const oauthFlowSchema = z.discriminatedUnion('type', [oauthPinFlowSchema]);

const hookOAuthInputSchema = z.object({
    type: z.literal('oauth'),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    provider: z.string().min(1),
    flow: oauthFlowSchema,
});

const hookQuestionInputSchema = z.object({
    type: z.literal('question'),
    id: z.string().min(1),
    question: questionSchema,
});

export const hookInputSchema = z.discriminatedUnion('type', [hookOAuthInputSchema, hookQuestionInputSchema]);

// ===== Consent =====

export const hookUserOptionalLinkSchema = z.object({
    url: z.url(),
    label: z.string().min(1),
});

/**
 * Install-time consent metadata in its v6 shape: the checkbox label renders
 * from the declaration's title, so only the body, the default and a link are
 * declared. (The v5 shape in hooks.ts carries its own label.)
 */
export const hookUserOptionalConsentSchema = z.object({
    description: z.string().optional(),
    default: z.boolean().optional(),
    link: hookUserOptionalLinkSchema.optional(),
});

// ===== Vocabulary =====

/** Descriptive taxonomy for surfaces (icons/grouping); the runtime never branches on it. */
export const hookKindSchema = z.enum(['connect', 'maintain', 'custom']);

/** Re-run semantics for user-fired hooks: connect-style hooks get re-run after half-failures. */
export const hookRerunSchema = z.enum(['idempotent', 'converge', 'refuse']);

/** Seconds before the runner abandons the script. */
export const hookTimeoutSchema = z.number().positive();

/** Automatic re-runs after a failure, lifecycle firings only. */
export const hookRetriesSchema = z.number().int().min(0);

// ===== Conditions =====

/** What a condition gates: whether the hook is shown at all, or whether it can run. */
export type HookConditionRole = 'visibility' | 'availability';

export interface HookConditionAppInstalled {
    role: HookConditionRole;
    type: 'appInstalled';
    app: string;
}

export interface HookConditionAppRunning {
    role: HookConditionRole;
    type: 'appRunning';
    app: string;
}

/** Semver range on an installed app's version. Evaluators that don't implement it must fail it closed. */
export interface HookConditionAppVersion {
    role: HookConditionRole;
    type: 'appVersion';
    app: string;
    range: string;
}

/** Reserved for P2 capability registry. */
export interface HookConditionCapabilityPresent {
    role: HookConditionRole;
    type: 'capabilityPresent';
    capability: string;
}

/** Escape hatch: local-side script predicate. Evaluators that don't implement it must fail it closed. */
export interface HookConditionScript {
    role: HookConditionRole;
    type: 'script';
    script: string;
    entrypoint?: string;
}

/**
 * A condition of a type this platform version doesn't know. Preserved from
 * parsing so evaluation can FAIL CLOSED (condition = false, logged) instead
 * of crashing — an old platform meeting a newer dictionary hides the hook.
 */
export interface HookConditionUnknown {
    role: HookConditionRole;
    type: 'unknown';
    originalType: string;
}

export type HookCondition =
    | HookConditionAppInstalled
    | HookConditionAppRunning
    | HookConditionAppVersion
    | HookConditionCapabilityPresent
    | HookConditionScript
    | HookConditionUnknown;

const roleSchema = z.enum(['visibility', 'availability']);

const knownConditionSchema = z.discriminatedUnion('type', [
    z.object({ role: roleSchema, type: z.literal('appInstalled'), app: z.string().min(1) }),
    z.object({ role: roleSchema, type: z.literal('appRunning'), app: z.string().min(1) }),
    z.object({ role: roleSchema, type: z.literal('appVersion'), app: z.string().min(1), range: z.string().min(1) }),
    z.object({ role: roleSchema, type: z.literal('capabilityPresent'), capability: z.string().min(1) }),
    z.object({
        role: roleSchema,
        type: z.literal('script'),
        script: z.string().min(1),
        entrypoint: z.string().min(1).optional(),
    }),
]);

const KNOWN_CONDITION_TYPES = new Set<string>([
    'appInstalled',
    'appRunning',
    'appVersion',
    'capabilityPresent',
    'script',
]);

// Unknown predicate types parse into an explicit `unknown` condition (fail
// closed at evaluation) rather than rejecting the whole declaration.
// Tolerance is for a FUTURE vocabulary only: a type this version KNOWS that
// fails its own shape is a typo, and reports the real issue instead of
// degrading into a permanently-false `unknown`.
// Parsed exactly once — the pairing and surface indexes each walk every
// dictionary in the catalog, so a second safeParse here doubles that work.
export const hookConditionSchema = z
    .object({ role: roleSchema, type: z.string().min(1) })
    .loose()
    .transform((raw, ctx): HookCondition => {
        if (!KNOWN_CONDITION_TYPES.has(raw.type)) {
            return { role: raw.role, type: 'unknown', originalType: raw.type } satisfies HookConditionUnknown;
        }
        const parsed = knownConditionSchema.safeParse(raw);
        if (parsed.success) return parsed.data as HookCondition;
        for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
        }
        return z.NEVER;
    });

// ===== App widget layout (platform-owned template; catalog fills slots) =====

// An app widget is the app's card (widgetsSchema 3): up to three slots beside
// the app's identity, and an image field behind both. A list slot also says
// how many rows it shows; one row is the featured form (title, bar, caption).
// An image is never a slot, because the card's artwork is its background.
export const widgetSlotsSchema = z
    .array(
        z.object({
            type: z.enum(['text', 'stat', 'list', 'progress']),
            field: z.string().min(1),
            rows: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        }),
    )
    .min(1)
    .max(3);

export const widgetBackgroundSchema = z.object({ field: z.string().min(1) });

// ===== VM widget sizes =====

// VM widgets still declare the sizes app widgets had under widgetsSchema 2.
// Nothing draws a VM widget yet; when something does, it takes the app
// widget's layout above and this goes.
const widgetSlotRefSchema = z.object({
    type: z.enum(['text', 'stat', 'list', 'image', 'progress']),
    field: z.string().min(1),
});

const widgetCardSlotRefSchema = widgetSlotRefSchema.extend({
    rows: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export const widgetSizesSchema = z.object({
    small: z
        .object({
            media: z.object({ placement: z.enum(['top', 'bottom']), field: z.string().min(1) }).optional(),
            slots: z.array(widgetSlotRefSchema).min(1).max(3),
        })
        .optional(),
    large: z
        .object({
            media: z.object({ placement: z.enum(['left', 'right', 'both']), field: z.string().min(1) }).optional(),
            slots: z.array(widgetSlotRefSchema).min(1).max(4),
        })
        .optional(),
    card: z
        .object({
            background: z.object({ field: z.string().min(1) }).optional(),
            slots: z.array(widgetCardSlotRefSchema).min(1).max(3),
        })
        .optional(),
});

// ===== Tolerant list parsing =====

/** The id a raw declaration claims, for error messages; "<no id>" when it has none. */
export function declaredId(raw: unknown): string {
    return typeof raw === 'object' && raw !== null && 'id' in raw ? String((raw as { id: unknown }).id) : '<no id>';
}

interface ItemSchema {
    safeParse: (
        raw: unknown,
    ) =>
        | { success: true; data: unknown }
        | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

/**
 * One tolerant parser for a dictionary's declaration fragments (hooks,
 * widgets). Forward-compatible by design: an unsupported schema version
 * returns supported=false (surfaces show nothing, never crash);
 * individually-invalid items are dropped with their errors reported; the
 * whole dictionary never fails on one bad entry.
 */
export function parseDeclarationList<T>(opts: {
    /** Error-message prefix, e.g. "Hook" / "Widget". */
    noun: string;
    /** Dictionary key holding the list, e.g. "widgets". */
    listKey: string;
    /** Dictionary key holding the schema version, e.g. "widgetsSchema". */
    schemaKey: string;
    list: unknown;
    schemaVersion: unknown;
    supportedVersion: number;
    itemSchema: ItemSchema;
}): { supported: boolean; items: T[]; errors: string[] } {
    const errors: string[] = [];

    if (opts.list == null) return { supported: true, items: [], errors };

    // A list with no schema key means "current dialect". Failing closed here
    // instead would cost an author their whole surface for one omitted line,
    // silently — the app still installs, the surface is just never offered.
    // A schema that is present but WRONG still fails closed.
    const schemaVersion = opts.schemaVersion ?? opts.supportedVersion;

    if (schemaVersion !== opts.supportedVersion) {
        return {
            supported: false,
            items: [],
            errors: [`Unsupported ${opts.schemaKey}: ${String(opts.schemaVersion)}`],
        };
    }

    if (!Array.isArray(opts.list)) {
        return { supported: true, items: [], errors: [`'${opts.listKey}' is not an array`] };
    }

    const items: T[] = [];
    for (const raw of opts.list) {
        const parsed = opts.itemSchema.safeParse(raw);
        if (parsed.success) {
            items.push(parsed.data as T);
        } else {
            // Issue paths tell the author WHERE, not just what.
            const detail = parsed.error.issues
                .map((issue) =>
                    issue.path.length > 0
                        ? `${issue.path.map((p) => String(p)).join('.')}: ${issue.message}`
                        : issue.message,
                )
                .join('; ');
            errors.push(`${opts.noun} ${declaredId(raw)}: ${detail}`);
        }
    }
    return { supported: true, items, errors };
}
