// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of a schema from the hexOS platform monorepo:
//   packages/shared/eshtek/vm-apps.ts
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

// VM app documents: the optional "Apps" selection a desktop VM install offers
// (hexos-vm-catalog repo, apps/ directory), synced into the main DB and served
// to clients alongside the blueprints.
//
// An app describes WHAT the user picked — the guest-side install stage decides
// HOW, by handing the id for the guest's runtime to that runtime's CLI. Nothing
// here is a download URL or a digest: unlike a blueprint source, the package
// manager owns fetching and verification, and duplicating either would be a
// second, staler copy of a claim the runtime already makes.

const appIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase alphanumerics and "-" only');

/**
 * Guest-side package runtimes an app can target. A blueprint declares the one
 * runtime its guest has (`apps.runtime`), and only apps carrying a target for
 * that runtime are offered for it — which is also how "Windows only" (7-Zip)
 * and "Linux only" (FileZilla, absent from winget) express themselves without
 * a platform flag.
 *
 * Deliberately closed, unlike blueprint `category`: an unknown runtime is not
 * a grouping the UI can degrade on, it is an install command nothing knows how
 * to build. Adding one means adding a renderer in the install pipeline first.
 */
export const VM_APP_RUNTIMES = ['winget', 'flatpak'] as const;
export type VMAppRuntime = (typeof VM_APP_RUNTIMES)[number];

/**
 * winget package identifier, e.g. "Mozilla.Firefox" or "Python.Python.3.14".
 * Dotted publisher.package(.variant) — the same string `winget install --id`
 * takes, and the same string that resolves to a manifest directory under
 * microsoft/winget-pkgs.
 */
export const WINGET_PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9+._-]*(?:\.[A-Za-z0-9+._-]+)+$/;

/**
 * Flatpak application id, e.g. "org.mozilla.firefox" — reverse-DNS, at least
 * three components in practice but two is legal, and case is significant
 * (org.gimp.GIMP).
 */
export const FLATPAK_APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;

const wingetTargetSchema = z.strictObject({
    id: z.string().min(1).max(128).regex(WINGET_PACKAGE_ID, 'dotted winget package id'),
    /**
     * Install scope. 'machine' installs for every user on the box, which is
     * what an unattended SYSTEM-context install wants; 'user' is for the
     * packages winget can only install per-user (MSIX/Store-backed ones),
     * which the guest stage has to defer to a logon-context task.
     *
     * Recorded per app because it is a property of the PACKAGE, not a
     * preference: asking for machine scope on a user-only package fails with
     * "no applicable installer", and the stage cannot tell that apart from a
     * genuine failure without knowing what it should have expected.
     */
    scope: z.enum(['machine', 'user']).default('machine'),
});

const flatpakTargetSchema = z.strictObject({
    id: z.string().min(1).max(255).regex(FLATPAK_APP_ID, 'reverse-DNS flatpak app id'),
    /** Flatpak remote the id is installed from. Flathub unless a vendor runs its own. */
    remote: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase remote name').default('flathub'),
});

export const vmAppTargetsSchema = z
    .strictObject({
        winget: wingetTargetSchema.optional(),
        flatpak: flatpakTargetSchema.optional(),
    })
    // An app with no target is offered to nothing — structurally valid and
    // completely inert, which is the kind of mistake that hides until someone
    // asks why the picker is short.
    .refine((targets) => Object.values(targets).some(Boolean), {
        message: 'at least one runtime target is required (winget, flatpak)',
    });

export const vmAppSchema = z.object({
    id: appIdSchema,
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(200),
    /**
     * Mirrored icon path, repo-relative (`_icons/apps/<id>.svg`), resolved
     * against the synced branch's raw-GitHub base exactly like a blueprint
     * icon. Optional: an app with no artwork renders a lettered tile, which is
     * a better outcome than an unattributed logo in a public repo.
     */
    icon: z.string().min(1).max(512).optional(),
    /** Product page, for the picker's "learn more" affordance. */
    website: z.url().max(512).optional(),
    /**
     * Grouping slug for the picker. Open like blueprint `category` and for the
     * same reason: the catalog updates fleet-wide instantly while clients roll
     * out per box, and a hard enum would validation-hide every app in a new
     * group rather than bucketing it under "Other". The strict allowlist lives
     * in hexos-vm-catalog/_lib/contract.ts, enforced by catalog CI.
     */
    category: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9-]*$/, 'lowercase slug (letters, digits, "-")')
        .optional(),
    /** Pre-checked in the picker. Curation, not quality — keep the set small. */
    recommended: z.boolean().default(false),
    /**
     * Installed footprint, so the wizard can raise its recommended disk size
     * rather than letting a user pick Steam and Blender onto a 32 GB zvol.
     * Approximate by nature; err high.
     */
    sizeMb: z.number().int().min(1).max(1_048_576).optional(),
    /** Skipped when syncing the prod catalog branch (mirrors blueprints). */
    internal: z.boolean().default(false),
    targets: vmAppTargetsSchema,
});

export type VMApp = z.infer<typeof vmAppSchema>;

/** Where an app row came from; admin rows are never touched by catalog syncs. */
export enum VMAppSource {
    Catalog = 'catalog',
    Admin = 'admin',
}

// What the main server serves to clients. Mirrors VMBlueprintRecord field for
// field so the two catalogs can share the admin table and sync reporting.
export interface VMAppRecord {
    appId: string;
    source: VMAppSource;
    enabled: boolean;
    hidden: boolean;
    /**
     * Pre-checked in the picker. Seeded from the document's own `recommended`
     * on first sync, then owned by the admin flag — so a per-environment
     * curation decision survives the next catalog sync, exactly as it does for
     * blueprints. Clients read THIS, not `document.recommended`.
     */
    recommended: boolean;
    /** Set (and the app auto-disabled) when the document no longer validates after a sync. */
    validationError: string | null;
    /** Catalog rows that disappeared from the repo; excluded from user-facing lists. */
    removedFromCatalog: boolean;
    document: VMApp;
    updatedAt: Date;
}

/** The apps offerable to a guest whose blueprint declares `runtime`. */
export const appsForRuntime = <T extends { targets: VMApp['targets'] }>(apps: T[], runtime: VMAppRuntime): T[] =>
    apps.filter((app) => app.targets[runtime] !== undefined);

/**
 * Rough installed footprint of a selection, in MB. Apps that declare no
 * `sizeMb` contribute nothing — the total is a floor, which is the honest
 * direction for a number the wizard uses to RAISE a disk default.
 */
export const appsTotalSizeMb = (apps: { sizeMb?: number }[]): number =>
    apps.reduce((total, app) => total + (app.sizeMb ?? 0), 0);
