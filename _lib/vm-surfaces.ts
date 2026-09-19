// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of a schema from the hexOS platform monorepo:
//   packages/shared/eshtek/vm-surfaces.ts
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
import {
    declaredId,
    type HookCondition,
    hookConditionSchema,
    hookInputSchema,
    hookKindSchema,
    hookRerunSchema,
    hookRetriesSchema,
    hookTimeoutSchema,
    hookUserOptionalConsentSchema,
    parseDeclarationList,
    widgetSizesSchema,
} from './surface-grammar';

// VM blueprint surfaces: the setup hooks and dashboard widgets a blueprint
// may declare under the loose root keys vm-blueprints.ts leaves as
// z.unknown(). Everything about their shape is enforced here, at read time,
// and reported as errors rather than by hiding the blueprint.
//
// Two forms of the same declaration exist:
//   authoring: the catalog file. `script` names a `.ts` or `.js` file by its
//              path from the catalog root, by convention in the blueprint's
//              own `<id>/` folder for hooks and widgets alike, as the app
//              catalog keeps each app's scripts; `scriptContent` and `source`
//              are the sync's to write, so their presence is an error.
//   stored:    the synced document a box reads. The sync inlined the file
//              into `scriptContent`, removed `script` and stamped
//              `source: "catalog"`. A stored declaration still carrying
//              `script` is dropped (a box never fetches code), and one whose
//              source is not "catalog" is dropped unless the box reports the
//              reserved vmUserHooks capability, which no build does.
//
// Events are `onAfterReady` (readiness confirmed the guest; the app install
// events would fire with no address to talk to), `userAction` (a verb on
// the card or a widget button) and `onMediaReconnected` (the platform saw a
// mounted media folder connected again after an outage; fired by the
// platform, never by a user, with the folders as event data). Each is a
// plain string: the app grammar's object form and any unknown entry are
// dropped per entry, and a declaration with no surviving event is dropped
// rather than defaulted to a verb.
//
// Zod and ./surface-grammar only: the VM catalog vendors both files.

// ===== Capabilities =====

/** Reported by a box whose build runs VM setup hooks and whose vm-hooks gate resolves for that server. */
export const VM_HOOKS_CAPABILITY = 'vmHooks';
/**
 * Reserved. A stored declaration with `source: "user"` survives parsing only
 * on a box reporting this, and no build reports it until the platform has an
 * out-of-process runner with a restricted API for user-authored scripts.
 */
export const VM_USER_HOOKS_CAPABILITY = 'vmUserHooks';

// ===== Vocabulary =====

export const SUPPORTED_VM_HOOKS_SCHEMA = 1;
export const SUPPORTED_VM_WIDGETS_SCHEMA = 2;
/** Declarations read per list; entries past the cap are dropped with an error. */
export const VM_SURFACE_LIST_CAP = 16;
/** ':' and ',' are delimiters in widget keys, so an id is a plain slug. */
export const VM_SURFACE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const VM_HOOK_EVENTS = ['onAfterReady', 'userAction', 'onMediaReconnected'] as const;
export type VMHookEvent = (typeof VM_HOOK_EVENTS)[number];
export const VM_HOOK_SURFACES = ['card', 'widget'] as const;
export type VMHookSurface = (typeof VM_HOOK_SURFACES)[number];
export const VM_DECLARATION_SOURCES = ['catalog', 'user'] as const;
export type VMDeclarationSource = (typeof VM_DECLARATION_SOURCES)[number];
export const VM_GUEST_SCHEMES = ['http', 'https'] as const;
export type VMGuestScheme = (typeof VM_GUEST_SCHEMES)[number];
/** Other declared ports a guest service answers on; a redirect may land on one of them. */
export const VM_ALT_PORTS_MAX = 4;

export type VMHookInput = z.infer<typeof hookInputSchema>;
export type VMHookConsent = z.infer<typeof hookUserOptionalConsentSchema>;
export type VMWidgetSizes = z.infer<typeof widgetSizesSchema>;

/** The endpoint a declaration talks to inside the guest, materialised from its fields or the launch URL. */
export interface VMGuestEndpoint {
    guestScheme: VMGuestScheme;
    guestPort: number;
    altPorts: number[];
}

export interface VMHookDeclaration extends VMGuestEndpoint {
    id: string;
    title: string;
    description?: string;
    kind?: z.infer<typeof hookKindSchema>;
    events: VMHookEvent[];
    /** onAfterReady only: a failure skips the hook instead of parking the setup. */
    optional?: boolean;
    /** onAfterReady only: the consent row in the installer; absence means the hook runs without a checkbox. */
    userOptional?: VMHookConsent;
    conditions?: HookCondition[];
    /** Where a userAction verb surfaces; absent in the file means both. */
    surfaces: VMHookSurface[];
    inputs?: VMHookInput[];
    /** Required iff the hook is user-triggerable. */
    rerun?: z.infer<typeof hookRerunSchema>;
    /** Authoring form only. */
    script?: string;
    /** Stored form only. */
    scriptContent?: string;
    entrypoint: string;
    timeout?: number;
    retries?: number;
    /** Stored form only. */
    source?: VMDeclarationSource;
}

export interface VMWidgetDeclaration extends VMGuestEndpoint {
    id: string;
    title: string;
    description?: string;
    /** Seconds between query refreshes. */
    refresh?: number;
    conditions?: HookCondition[];
    sizes?: VMWidgetSizes;
    /** Ids of this blueprint's userAction hooks with the widget surface, rendered as buttons. */
    buttons?: string[];
    script?: string;
    scriptContent?: string;
    entrypoint: string;
    timeout?: number;
    source?: VMDeclarationSource;
}

/** The form a list is parsed in, and what the reading box reports. */
export interface ParseVMSurfacesOptions {
    form: 'authoring' | 'stored';
    /** Capabilities of the reading box; only vmUserHooks is consulted here. Absent means none. */
    capabilities?: readonly string[];
}

/** The root keys the parsers read, plus the launch URL that supplies the port default. */
export interface VMSurfaceDocument {
    hooksSchema?: unknown;
    hooks?: unknown;
    widgetsSchema?: unknown;
    widgets?: unknown;
    guest?: { postInstallUrl?: string };
}

// ===== Endpoint defaults =====

export interface VMLaunchEndpoint {
    scheme: VMGuestScheme;
    port: number;
}

/**
 * The scheme and port a blueprint's launch URL names ("http://{ip}:8123/"
 * names 8123; "http://{ip}/" names 80 through its scheme), or undefined
 * when there is no HTTP launch URL. A declaration without its own guestPort
 * takes this; with neither it is dropped, because there is no port to try.
 */
export function launchEndpoint(postInstallUrl: string | undefined): VMLaunchEndpoint | undefined {
    if (!postInstallUrl) return undefined;
    let url: URL;
    try {
        // "{ip}" is substituted at install time and is not a host the parser accepts.
        url = new URL(postInstallUrl.replace('{ip}', '203.0.113.1'));
    } catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const scheme: VMGuestScheme = url.protocol === 'https:' ? 'https' : 'http';
    const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port);
    // The URL parser accepts port 0; a default has to satisfy the same range a declared port does.
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { scheme, port };
}

// ===== Script paths =====

/**
 * Why an authored script path is refused, or undefined when it is
 * acceptable: a path relative to the catalog root (by convention the
 * blueprint's own folder, which is a review convention, not a rule, as in the
 * app catalog), a TypeScript or JavaScript file, no empty, "." or ".."
 * segments, and only characters a URL carries verbatim as path segments. The
 * sync appends the path to the pinned commit's URL, and a URL parser reads
 * "%2e%2e" as ".." and "\" as "/", so a "%" or "\" would let a segment
 * climb out of that commit; "?" and "#" would end the path early. The same
 * rules the app hook resolver applies to file-backed scripts, plus the
 * character set.
 */
export function vmScriptPathError(path: string): string | undefined {
    if (path.includes('\0')) return 'contains a null byte';
    if (!/^[A-Za-z0-9_./-]+$/.test(path)) return 'may contain only letters, digits, "_", "-", "." and "/"';
    if (path.startsWith('/')) return 'must be relative to the catalog root';
    if (!/\.(ts|js)$/.test(path)) return 'must end in .ts or .js';
    if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return 'must not contain empty, "." or ".." segments';
    }
    return undefined;
}

// ===== Zod =====

const portSchema = z.number().int().min(1).max(65535);
const idSchema = z.string().regex(VM_SURFACE_ID_PATTERN, 'lowercase slug of 1 to 64 letters, digits, "_" or "-"');

const endpointFields = {
    guestScheme: z.enum(VM_GUEST_SCHEMES).optional(),
    guestPort: portSchema.optional(),
    altPorts: z.array(portSchema).max(VM_ALT_PORTS_MAX).optional(),
};

const scriptFields = {
    script: z.string().min(1).optional(),
    scriptContent: z.string().min(1).optional(),
    entrypoint: z.string().min(1),
    source: z.enum(VM_DECLARATION_SOURCES).optional(),
};

/** The shape of one hook declaration, either form; the form-specific rules are applied by parseVMHooks. */
export const vmHookDeclarationSchema = z.object({
    id: idSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    kind: hookKindSchema.optional(),
    events: z.array(z.enum(VM_HOOK_EVENTS)).min(1),
    optional: z.boolean().optional(),
    userOptional: hookUserOptionalConsentSchema.optional(),
    conditions: z.array(hookConditionSchema).optional(),
    surfaces: z.array(z.enum(VM_HOOK_SURFACES)).min(1).optional(),
    inputs: z.array(hookInputSchema).optional(),
    rerun: hookRerunSchema.optional(),
    ...endpointFields,
    ...scriptFields,
    timeout: hookTimeoutSchema.optional(),
    retries: hookRetriesSchema.optional(),
    // Captured only to lint against: the app grammar's file target has no VM
    // analogue, and a v5-style singular `event` would otherwise be stripped
    // silently. See the refinements in parseVMHooks.
    target: z.unknown().optional(),
    event: z.unknown().optional(),
});

/** The shape of one widget declaration, either form; the form-specific rules are applied by parseVMWidgets. */
export const vmWidgetDeclarationSchema = z.object({
    id: idSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    refresh: z.number().int().positive().optional(),
    conditions: z.array(hookConditionSchema).optional(),
    sizes: widgetSizesSchema.optional(),
    buttons: z
        .array(z.string().min(1))
        .max(4)
        .refine((ids) => new Set(ids).size === ids.length, { message: 'button hook ids must be unique' })
        .optional(),
    ...endpointFields,
    ...scriptFields,
    timeout: hookTimeoutSchema.optional(),
});

type ScriptSourceFields = { script?: string; scriptContent?: string; source?: VMDeclarationSource };

/** The form rules, shared by hooks and widgets. */
function scriptSourceIssues(decl: ScriptSourceFields, opts: ParseVMSurfacesOptions): string[] {
    const issues: string[] = [];
    if (opts.form === 'authoring') {
        if (decl.script == null) issues.push('script is required: a relative .ts or .js path in the catalog');
        else {
            const why = vmScriptPathError(decl.script);
            if (why) issues.push(`script ${why}`);
        }
        if (decl.scriptContent != null) issues.push('scriptContent is written by the sync, never authored');
        if (decl.source != null) issues.push('source is assigned by the sync, never authored');
        return issues;
    }
    if (decl.script != null) issues.push('a stored declaration names no script path; the box never fetches code');
    if (decl.scriptContent == null) issues.push('scriptContent is missing');
    if (decl.source == null) issues.push('source is missing');
    else if (decl.source !== 'catalog' && !(opts.capabilities ?? []).includes(VM_USER_HOOKS_CAPABILITY)) {
        issues.push(`source "${decl.source}" is refused until this box reports ${VM_USER_HOOKS_CAPABILITY}`);
    }
    return issues;
}

type EndpointFields = { guestScheme?: VMGuestScheme; guestPort?: number; altPorts?: number[] };

function materialiseEndpoint(decl: EndpointFields, launch: VMLaunchEndpoint | undefined): VMGuestEndpoint {
    return {
        guestScheme: decl.guestScheme ?? launch?.scheme ?? 'http',
        // Refined before this runs: a declaration with neither is dropped.
        guestPort: decl.guestPort ?? launch?.port ?? 0,
        altPorts: decl.altPorts ?? [],
    };
}

const NO_PORT = 'guestPort is required when guest.postInstallUrl names no port';

function hookSchemaFor(opts: ParseVMSurfacesOptions, launch: VMLaunchEndpoint | undefined) {
    return vmHookDeclarationSchema
        .superRefine((decl, ctx) => {
            const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
            if (decl.event !== undefined) {
                issue(
                    'VM hooks use `events` (an array of onAfterReady / userAction / onMediaReconnected); found a singular `event`',
                );
            }
            if (decl.target !== undefined) issue('file targets have no VM analogue; remove `target`');
            const lifecycle = decl.events.includes('onAfterReady');
            const userTriggerable = decl.events.includes('userAction');
            const platformFired = decl.events.includes('onMediaReconnected');
            if (platformFired && (lifecycle || userTriggerable)) {
                issue(
                    'an onMediaReconnected hook is its own declaration: it may not also handle onAfterReady or userAction',
                );
            }
            if (decl.optional != null && !lifecycle && !platformFired) {
                issue(
                    '`optional` requires the onAfterReady or onMediaReconnected event; user firings are always terminal',
                );
            }
            if (platformFired && (decl.inputs?.length ?? 0) > 0) {
                issue('an onMediaReconnected hook runs with no user to ask; remove `inputs`');
            }
            if (decl.userOptional != null && !lifecycle) {
                issue('`userOptional` requires the onAfterReady event; the consent row renders nowhere else');
            }
            if (decl.kind === 'connect' && lifecycle && decl.userOptional?.default !== false) {
                issue(
                    'a connect hook signs the user in somewhere; its consent must default to unchecked: declare `userOptional` with `default: false`',
                );
            }
            if (userTriggerable && decl.rerun == null) issue('`rerun` is required on user-triggerable hooks');
            if (!userTriggerable && decl.rerun != null) {
                issue('`rerun` applies to user firings only; remove it from this lifecycle-only hook');
            }
            for (const message of scriptSourceIssues(decl, opts)) issue(message);
            if (decl.guestPort == null && launch == null) issue(NO_PORT);
        })
        .transform((decl): VMHookDeclaration => {
            const { target: _target, event: _event, guestScheme, guestPort, altPorts, surfaces, ...rest } = decl;
            return {
                ...rest,
                surfaces: surfaces ?? [...VM_HOOK_SURFACES],
                ...materialiseEndpoint({ guestScheme, guestPort, altPorts }, launch),
            };
        });
}

function widgetSchemaFor(opts: ParseVMSurfacesOptions, launch: VMLaunchEndpoint | undefined) {
    return vmWidgetDeclarationSchema
        .superRefine((decl, ctx) => {
            const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
            for (const message of scriptSourceIssues(decl, opts)) issue(message);
            if (decl.guestPort == null && launch == null) issue(NO_PORT);
        })
        .transform((decl): VMWidgetDeclaration => {
            const { guestScheme, guestPort, altPorts, ...rest } = decl;
            return { ...rest, ...materialiseEndpoint({ guestScheme, guestPort, altPorts }, launch) };
        });
}

// ===== Tolerant parsing =====

const KNOWN_EVENTS = new Set<string>(VM_HOOK_EVENTS);

function unsupportedVersion(schemaKey: string, declared: unknown, supported: number): string | undefined {
    // Absence means the current dialect; anything present, null included, must be the supported integer.
    if (declared === undefined || declared === supported) return undefined;
    return `Unsupported ${schemaKey}: ${JSON.stringify(declared)}`;
}

/** The cap, applied before anything else reads the list. */
function capped(list: unknown[], listKey: string, errors: string[]): unknown[] {
    if (list.length <= VM_SURFACE_LIST_CAP) return list;
    errors.push(`'${listKey}' lists ${list.length} declarations; only the first ${VM_SURFACE_LIST_CAP} are read`);
    return list.slice(0, VM_SURFACE_LIST_CAP);
}

/**
 * Per-ENTRY tolerance for events, before declaration validation: entries a
 * future vocabulary added (or the app grammar's object form) are dropped
 * fail-closed with an error, and a declaration whose events all dropped, or
 * that declares none, is dropped with an error, never defaulted to a verb.
 */
function tolerateEvents(list: unknown[], errors: string[]): unknown[] {
    const kept: unknown[] = [];
    for (const raw of list) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            kept.push(raw); // reported by the item schema as "expected object"
            continue;
        }
        const record = raw as Record<string, unknown>;
        const id = declaredId(raw);
        if (!Array.isArray(record.events)) {
            errors.push(
                `Hook ${id}: events is required (onAfterReady, userAction, onMediaReconnected) — declaration dropped`,
            );
            continue;
        }
        const events = record.events.filter((entry) => typeof entry === 'string' && KNOWN_EVENTS.has(entry));
        if (events.length < record.events.length) {
            errors.push(`Hook ${id}: ${record.events.length - events.length} unrecognized event entr(y/ies) dropped`);
        }
        if (events.length === 0) {
            errors.push(`Hook ${id}: no recognized events — declaration dropped`);
            continue;
        }
        kept.push({ ...record, events });
    }
    return kept;
}

/** Ids are load-bearing (opt-ins, task history, widget buttons), so a collision drops the LATER declaration. */
function dedupe<T extends { id: string }>(items: T[], noun: string, errors: string[]): T[] {
    const ids = new Set<string>();
    const unique: T[] = [];
    for (const item of items) {
        if (ids.has(item.id)) {
            errors.push(`Duplicate ${noun.toLowerCase()} id "${item.id}" — ids must be unique per blueprint`);
            continue;
        }
        ids.add(item.id);
        unique.push(item);
    }
    return unique;
}

/**
 * Parse a blueprint's hooks, tolerantly. An unsupported hooksSchema yields
 * zero hooks with an error and supported=false; a non-array list yields
 * zero hooks with an error; invalid items are dropped with their errors;
 * the whole list never fails on one bad entry.
 */
export function parseVMHooks(
    document: VMSurfaceDocument,
    opts: ParseVMSurfacesOptions,
): { supported: boolean; hooks: VMHookDeclaration[]; errors: string[] } {
    const errors: string[] = [];
    if (document.hooks == null) return { supported: true, hooks: [], errors };
    const unsupported = unsupportedVersion('hooksSchema', document.hooksSchema, SUPPORTED_VM_HOOKS_SCHEMA);
    if (unsupported) return { supported: false, hooks: [], errors: [unsupported] };

    const list = Array.isArray(document.hooks)
        ? tolerateEvents(capped(document.hooks, 'hooks', errors), errors)
        : document.hooks;
    const parsed = parseDeclarationList<VMHookDeclaration>({
        noun: 'Hook',
        listKey: 'hooks',
        schemaKey: 'hooksSchema',
        list,
        schemaVersion: SUPPORTED_VM_HOOKS_SCHEMA,
        supportedVersion: SUPPORTED_VM_HOOKS_SCHEMA,
        itemSchema: hookSchemaFor(opts, launchEndpoint(document.guest?.postInstallUrl)),
    });
    errors.push(...parsed.errors);
    const hooks = dedupe(parsed.items, 'Hook', errors);
    // One handler per platform-fired event: the platform tracks one run per firing.
    const handlers = hooks.filter((hook) => hook.events.includes('onMediaReconnected'));
    if (handlers.length > 1) {
        errors.push(
            `Hooks ${handlers.map((hook) => hook.id).join(', ')}: only one hook may handle onMediaReconnected — declarations dropped`,
        );
        return { supported: true, hooks: hooks.filter((hook) => !hook.events.includes('onMediaReconnected')), errors };
    }
    return { supported: true, hooks, errors };
}

/**
 * Parse a blueprint's widgets, tolerantly, the same way. `hooks` are the
 * blueprint's parsed hooks: a button must name one that is user-triggerable
 * and allows the widget surface; any other reference is dropped from the
 * widget with an error, and the widget itself is kept.
 */
export function parseVMWidgets(
    document: VMSurfaceDocument,
    opts: ParseVMSurfacesOptions & { hooks: readonly VMHookDeclaration[] },
): { supported: boolean; widgets: VMWidgetDeclaration[]; errors: string[] } {
    const errors: string[] = [];
    if (document.widgets == null) return { supported: true, widgets: [], errors };
    const unsupported = unsupportedVersion('widgetsSchema', document.widgetsSchema, SUPPORTED_VM_WIDGETS_SCHEMA);
    if (unsupported) return { supported: false, widgets: [], errors: [unsupported] };

    const list = Array.isArray(document.widgets) ? capped(document.widgets, 'widgets', errors) : document.widgets;
    const parsed = parseDeclarationList<VMWidgetDeclaration>({
        noun: 'Widget',
        listKey: 'widgets',
        schemaKey: 'widgetsSchema',
        list,
        schemaVersion: SUPPORTED_VM_WIDGETS_SCHEMA,
        supportedVersion: SUPPORTED_VM_WIDGETS_SCHEMA,
        itemSchema: widgetSchemaFor(opts, launchEndpoint(document.guest?.postInstallUrl)),
    });
    errors.push(...parsed.errors);

    const buttonable = new Set(
        opts.hooks
            .filter((hook) => hook.events.includes('userAction') && hook.surfaces.includes('widget'))
            .map((hook) => hook.id),
    );
    const widgets = dedupe(parsed.items, 'Widget', errors).map((widget) => {
        if (!widget.buttons) return widget;
        const buttons = widget.buttons.filter((hookId) => {
            if (buttonable.has(hookId)) return true;
            errors.push(
                `Widget ${widget.id}: button "${hookId}" is not a userAction hook with the widget surface — dropped`,
            );
            return false;
        });
        return { ...widget, buttons };
    });
    return { supported: true, widgets, errors };
}

// ===== Executable keys =====

/**
 * The root keys that carry code or select how it is parsed. The catalog
 * sync is the only writer: an admin override that adds, removes or replaces
 * them would be a fleet code channel with no review, so the admin path
 * refuses such an edit and preserves these keys when a submission lacks them.
 */
export const VM_BLUEPRINT_EXECUTABLE_KEYS = ['hooksSchema', 'hooks', 'widgetsSchema', 'widgets'] as const;

/** `edited` with every executable key it lacks copied from `document`; the input objects are untouched. */
export function preserveExecutableKeys(
    document: Record<string, unknown>,
    edited: Record<string, unknown>,
): Record<string, unknown> {
    const preserved: Record<string, unknown> = { ...edited };
    for (const key of VM_BLUEPRINT_EXECUTABLE_KEYS) {
        if (!(key in preserved) && key in document) preserved[key] = document[key];
    }
    return preserved;
}

/** Whether any executable key differs between the two documents (absent and undefined are the same thing). */
export function executableKeysDiffer(document: Record<string, unknown>, edited: Record<string, unknown>): boolean {
    return VM_BLUEPRINT_EXECUTABLE_KEYS.some(
        (key) => JSON.stringify(document[key] ?? null) !== JSON.stringify(edited[key] ?? null),
    );
}

/** Whether a document declares anything under an executable key. */
export function hasExecutableContent(document: Record<string, unknown>): boolean {
    return VM_BLUEPRINT_EXECUTABLE_KEYS.some((key) => document[key] !== undefined && document[key] !== null);
}

// ===== Import lint =====

/**
 * Blank the contents of comments, string literals and template literals
 * (keeping newlines and the quote characters), so the import scan below
 * cannot be fooled by text that merely mentions an import. Template
 * literals are treated as opaque, expressions included.
 */
function blankCommentsAndStrings(source: string): string {
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
        const ch = source[i] as string;
        const next = source[i + 1];
        if (ch === '/' && next === '/') {
            while (i < n && source[i] !== '\n') {
                out += ' ';
                i += 1;
            }
            continue;
        }
        if (ch === '/' && next === '*') {
            out += '  ';
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
                out += source[i] === '\n' ? '\n' : ' ';
                i += 1;
            }
            out += '  ';
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            out += ch;
            i += 1;
            while (i < n && source[i] !== ch) {
                if (source[i] === '\\') {
                    out += ' ';
                    i += 1;
                }
                out += source[i] === '\n' ? '\n' : ' ';
                i += 1;
            }
            out += ch;
            i += 1;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

/**
 * A braced import specifier the transpiler erases: `type X` or `type X as Y`.
 * TypeScript reads `type as X` as the value export named `type` renamed X,
 * and `type as as` as `type` renamed `as`: both load the module. The rarer
 * type-only spellings that also begin `type as` (`type as`, `type as as as`)
 * are refused with them, which costs an author a rename and nothing else.
 */
const isTypeOnlySpecifier = (specifier: string): boolean =>
    /^type\s+(?!as\b)[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(specifier);

/**
 * Runtime imports an inlined script may not carry. The box runs inlined
 * content through an in-process dynamic import, so `import x from "y"` or
 * `require("y")` would resolve against the backend's own modules and either
 * fail at load or reach code the catalog never reviewed. Type-only imports
 * (`import type X ...`, or every braced specifier spelled `type X`) are
 * erased by the transpiler and allowed. This is a statement scan, not a
 * parse: an import inside a template literal's `${}` is not seen, a regex
 * literal containing `import(` is refused, and `import.meta` or
 * `require.resolve` pass because they load nothing. Returns one message per
 * offending statement, with its line; an empty list means the script passes.
 */
export function lintScriptImports(source: string): string[] {
    const code = blankCommentsAndStrings(source);
    const errors: string[] = [];
    const report = (index: number, what: string) => errors.push(`line ${lineOf(code, index)}: ${what}`);

    for (const match of code.matchAll(/\bimport\s+(type\s+)?([^;'"]*?)\s*from\s*['"]/g)) {
        const clause = (match[2] ?? '').trim();
        // `import type X`, `import type { X }` and `import type * as ns` are erased;
        // `import type from "m"` and `import type , { x } from "m"` bind a default
        // named `type` (comments before the comma are already blanked to spaces).
        if (match[1] && /^[{*A-Za-z_$]/.test(clause)) continue;
        const braced = /^\{([\s\S]*)\}$/.exec(clause);
        if (braced) {
            const specifiers = (braced[1] ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            if (specifiers.length > 0 && specifiers.every(isTypeOnlySpecifier)) continue;
        }
        report(match.index, 'runtime import; inlined scripts may only import types');
    }
    for (const match of code.matchAll(/\bimport\s*['"]/g)) {
        report(match.index, 'side-effect import; inlined scripts may not load modules');
    }
    for (const match of code.matchAll(/\bimport\s*\(/g)) {
        report(match.index, 'dynamic import(); inlined scripts may not load modules');
    }
    for (const match of code.matchAll(/\brequire\s*\(/g)) {
        report(match.index, 'require(); inlined scripts may not load modules');
    }
    for (const match of code.matchAll(/\bexport\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*['"]/g)) {
        if (match[1]) continue;
        report(match.index, 're-export from a module; inlined scripts may not load modules');
    }
    return errors.sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
}

/**
 * Consent for one userOptional hook: the explicit answer where one was given,
 * else the declaration's default, where only an explicit `default: false`
 * reads as not consented (the app installer's rule, `isAppSurfaceHookOptedIn`;
 * the grammar requires that default of a hook that signs the user in
 * somewhere, so an absent answer is "not consented" there without a second
 * rule). One rule for the installer's switches, the deck's seed and the box's
 * snapshot, so the consent shown and the consent applied cannot differ.
 */
export const isVMSetupHookOptedIn = (
    hook: Pick<VMHookDeclaration, 'id' | 'userOptional'>,
    hookOptIns: Record<string, boolean> | undefined,
): boolean => hookOptIns?.[hook.id] ?? hook.userOptional?.default !== false;
