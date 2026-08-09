// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of the blueprint schema from the hexOS platform monorepo:
//   packages/shared/eshtek/vm-blueprints.ts
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
// catalog sync in hexos-platform re-validates every blueprint with the real
// schema at read time, so the server is always the authoritative gate.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// VM blueprint documents: the curated one-click VM catalog (hexos-vm-catalog
// repo), synced into the main DB and served to clients.
//
// A blueprint describes WHAT to deploy (image/answers, resource envelope,
// guest hardware) — the local backend's install pipeline decides HOW
// (pool/zvol placement, host-exec image writing, device creation).

const blueprintIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, 'lowercase alphanumerics, "." and "-" only');

// ── Checksums ────────────────────────────────────────────────────────────────
// Sources carry one or both of sha256/sha512. Two algorithms because not every
// publisher offers a choice: Canonical, Fedora and OpenWrt publish SHA-256,
// while Debian's cloud images and openSUSE publish only SHA-512. At least one
// digest is always required — an unverified image is never booted — and the
// install pipeline verifies EVERY digest present, so listing both is a strictly
// stronger claim, not a fallback chain.

export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const SHA512_HEX = /^[a-f0-9]{128}$/;

export type ChecksumAlgorithm = 'sha256' | 'sha512';

export interface SourceDigest {
    algorithm: ChecksumAlgorithm;
    value: string;
}

const checksumFieldsSchema = {
    /** sha256 of the file as downloaded (i.e. before decompression). Lowercase hex. */
    sha256: z.string().regex(SHA256_HEX).optional(),
    /** sha512 of the file as downloaded (i.e. before decompression). Lowercase hex. */
    sha512: z.string().regex(SHA512_HEX).optional(),
};

const requireOneDigest = <T extends { sha256?: string; sha512?: string }>(source: T) =>
    Boolean(source.sha256 || source.sha512);

const ONE_DIGEST_MESSAGE = 'at least one of sha256 or sha512 is required — never boot an unverified image';

/**
 * Every digest a source claims, strongest first. The install pipeline must
 * verify ALL of them; a mismatch on any one fails the install. Returns at
 * least one entry for any source that passed schema validation.
 */
export function sourceDigests(source: { sha256?: string; sha512?: string }): SourceDigest[] {
    const digests: SourceDigest[] = [];
    if (source.sha512) digests.push({ algorithm: 'sha512', value: source.sha512 });
    if (source.sha256) digests.push({ algorithm: 'sha256', value: source.sha256 });
    return digests;
}

// Where the next version comes from. `url` pins one artifact and says nothing
// about what supersedes it, so a source may also name the vendor listing a
// maintainer reads to bump it. Editorial metadata: nothing here fetches it and
// no client renders it (that is isoHelpUrl's job, below).
const releasesUrlField = {
    /** Vendor page listing available releases and their published digests. */
    releasesUrl: z.string().url().startsWith('https://').max(512).optional(),
};

// Downloadable disk image. `url` may contain "{version}" placeholders that are
// substituted with `version` at install time, so version bumps are a
// two-field catalog change (version + digest).
export const vmImageSourceSchema = z
    .object({
        url: z.string().url().startsWith('https://'),
        version: z.string().min(1).max(64),
        format: z.enum(['raw', 'qcow2']),
        // bz2 is here for FreeBSD-derived appliance images (OPNsense ships
        // .img.bz2). 7z is deliberately absent — it would need a bundled extractor
        // and a "which member of the archive" field, since it is a container rather
        // than a stream filter like the rest.
        compression: z.enum(['none', 'xz', 'gz', 'zstd', 'bz2']).default('none'),
        ...checksumFieldsSchema,
        ...releasesUrlField,
    })
    .refine(requireOneDigest, { message: ONE_DIGEST_MESSAGE, path: ['sha256'] });

// Downloadable installer ISO (freely redistributable media, unlike user-iso).
// `url` may contain "{version}" placeholders like vmImageSourceSchema.
export const vmInstallerIsoSourceSchema = z
    .object({
        url: z.string().url().startsWith('https://'),
        version: z.string().min(1).max(64),
        ...checksumFieldsSchema,
        ...releasesUrlField,
    })
    .refine(requireOneDigest, { message: ONE_DIGEST_MESSAGE, path: ['sha256'] });

// The user supplies the installer ISO (e.g. Windows — not redistributable).
export const vmUserIsoSourceSchema = z.object({
    type: z.literal('user-iso'),
    /**
     * The vendor's official download page, offered as a link in the install
     * dialog (a link only — scripted retrieval stays off the table). Distinct
     * from releasesUrl, which no client renders, even where the two point at
     * the same page: this one is product copy.
     */
    isoHelpUrl: z.string().url().startsWith('https://').optional(),
    ...releasesUrlField,
});

export const vmExtraMediaSchema = z.object({
    /** Slug charset — the id becomes part of a host-side cache filename. */
    id: blueprintIdSchema,
    url: z.string().url().startsWith('https://'),
    // Unlike the primary source, extra media may carry no digest at all
    // (historically permitted); catalog CI warns rather than rejecting.
    ...checksumFieldsSchema,
});

const provisioningImageSchema = z.object({
    strategy: z.literal('image'),
    source: vmImageSourceSchema,
});

const provisioningCloudInitSchema = z.object({
    strategy: z.literal('cloud-init'),
    source: vmImageSourceSchema,
    cloudInit: z.object({
        /** Named user-data template shipped in the backend (not arbitrary catalog-supplied cloud-config). */
        userDataTemplate: z.string().min(1).max(64),
    }),
});

const provisioningAnswerFileSchema = z.object({
    strategy: z.literal('answer-file'),
    source: vmUserIsoSourceSchema,
    answerFile: z.object({
        /** Named autounattend template shipped in the backend. */
        template: z.string().min(1).max(64),
    }),
    /** Additional ISOs attached as CD-ROMs (e.g. virtio drivers). */
    extraMedia: z.array(vmExtraMediaSchema).max(4).default([]),
});

// Boot a downloaded installer ISO with a generated answer/seed ISO alongside
// (Ubuntu Desktop autoinstall via a NoCloud "cidata" seed, Fedora kickstart
// via an "OEMDRV" volume). The zvol starts blank; the installer fills it.
const provisioningInstallerIsoSchema = z.object({
    strategy: z.literal('installer-iso'),
    source: vmInstallerIsoSourceSchema,
    seed: z.object({
        /** Named installer-seed template shipped in the backend (not arbitrary catalog-supplied config). */
        template: z.string().min(1).max(64),
    }),
});

// Container hosts configured by a machine config rather than cloud-init: Fedora
// CoreOS and Flatcar (Ignition), Talos (its own machine config). Distinct from
// 'cloud-init' because these guests ship no cloud-init at all, and distinct from
// 'image' because without the config they boot unconfigured and unreachable.
const provisioningMachineConfigSchema = z.object({
    strategy: z.literal('machine-config'),
    source: vmImageSourceSchema,
    machineConfig: z.object({
        /** Named config template shipped in the backend (not arbitrary catalog-supplied config). */
        template: z.string().min(1).max(64),
        /**
         * How the host hands the rendered document to the guest.
         * 'config-drive' — extra volume with a well-known label, read at first boot
         *                  (openstack 'config-2' for Ignition guests, Talos nocloud).
         *                  What everything ships with: the volume can be ejected and
         *                  scrubbed once the install is confirmed.
         * 'fw-cfg'       — QEMU fw_cfg blob at opt/com.coreos/config. Works on every
         *                  supported train, but rides in the domain's command line,
         *                  where it is visible in `ps` and cannot be scrubbed after
         *                  install. No template uses it today.
         */
        delivery: z.enum(['fw-cfg', 'config-drive']),
    }),
});

export const vmProvisioningSchema = z.discriminatedUnion('strategy', [
    provisioningImageSchema,
    provisioningCloudInitSchema,
    provisioningAnswerFileSchema,
    provisioningInstallerIsoSchema,
    provisioningMachineConfigSchema,
]);

export const vmBlueprintResourcesSchema = z
    .object({
        minMemoryMb: z.number().int().min(256),
        recMemoryMb: z.number().int().min(256),
        minVcpus: z.number().int().min(1).max(64),
        recVcpus: z.number().int().min(1).max(64),
        diskGb: z.number().int().min(1).max(4096),
    })
    .refine((r) => r.recMemoryMb >= r.minMemoryMb, { message: 'recMemoryMb must be >= minMemoryMb' })
    .refine((r) => r.recVcpus >= r.minVcpus, { message: 'recVcpus must be >= minVcpus' });

// How the install pipeline confirms the guest is up. All strategies share the
// same timeout and fall back to "started, unconfirmed".
export const vmReadinessSchema = z.discriminatedUnion('type', [
    z.object({
        /** cloud-init phone_home / Windows FirstLogonCommand posting to the relay endpoint. */
        type: z.literal('phone-home'),
    }),
    z.object({
        type: z.literal('mdns'),
        hostname: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
    }),
    z.object({
        /** Best-effort MAC -> IP resolution + port probe. */
        type: z.literal('arp'),
        port: z.number().int().min(1).max(65535),
    }),
]);

export const vmBlueprintGuestSchema = z.object({
    firmware: z.enum(['UEFI']).default('UEFI'),
    diskBus: z.enum(['AHCI', 'VIRTIO']).default('VIRTIO'),
    nicModel: z.enum(['E1000', 'VIRTIO']).default('VIRTIO'),
    tpm: z.boolean().default(false),
    secureBoot: z.boolean().default(false),
    hypervEnlightenments: z.boolean().default(false),
    /** Start the VM with the host. Appliance-style guests want true. */
    autostart: z.boolean().default(true),
    /** Offer attaching a host GPU (PCI passthrough) in the install dialog. */
    gpuPassthrough: z.boolean().default(false),
    /** Take a "fresh install" zvol snapshot once the install is confirmed online. */
    installSnapshot: z.boolean().default(true),
    readiness: vmReadinessSchema,
    /** Success-notification deep link; "{ip}" is substituted with the discovered address. */
    postInstallUrl: z.string().max(512).optional(),
});

export const vmBlueprintSchema = z.object({
    id: blueprintIdSchema,
    name: z.string().min(1).max(128),
    description: z.string().max(1024).default(''),
    /** Icon key, resolved like VMIcons (e.g. "vms/haos"). */
    icon: z.string().max(128).optional(),
    /**
     * The distro's own product page, offered as the "Website" button in the
     * catalog detail sheet. Distinct from `provisioning.source.releasesUrl`
     * (maintainer-facing, never rendered) even when the two agree: this one is
     * product copy, the same role `homepage` plays for apps.
     */
    website: z.string().url().startsWith('https://').max(512).optional(),
    /**
     * Desktop screenshots of the version this blueprint installs, rendered as
     * the detail sheet's gallery (up to 5 shown).
     *
     * Two accepted forms, and BOTH must stay valid: a path relative to the
     * catalog repo (e.g. "zorin-os-18/screenshots/desktop.png"), which is what
     * a catalog file carries, and an absolute https URL, which is what the same
     * document holds AFTER syncVMBlueprintCatalog resolves those paths against
     * the branch's raw-GitHub base (dev: /vm-catalog-assets/...). The stored
     * document is re-validated on every sync, so rejecting the resolved form
     * would disable every blueprint carrying a screenshot.
     */
    screenshots: z.array(z.string().min(1).max(512)).max(8).default([]),
    /**
     * Category slug used to group the user-facing catalog. Deliberately not a
     * hard enum — sync re-validates every stored document, and an enum would
     * validationError-hide blueprints whenever the catalog adds a category
     * before the platform deploys. The strict allowlist (server | desktop |
     * appliance) lives in hexos-vm-catalog/_lib/contract.ts, enforced by
     * catalog CI; clients group unknown values into a fallback bucket.
     */
    category: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9-]*$/, 'lowercase slug (letters, digits, "-")')
        .optional(),
    /** TrueNAS version range gate, evaluated with isTrueNASVersionInRange (e.g. ">=25.04.2.6"). */
    truenasVersion: z.string().max(64).optional(),
    /**
     * CPU feature flags the host must have (as named in /proc/cpuinfo, e.g.
     * "avx2"; matching is case-insensitive). Guests see the host CPU (VMs are
     * created with host passthrough), so distros with a baseline like
     * x86-64-v3 list its flags here. Evaluated with missingCpuFeatures.
     */
    cpuFeatures: z
        .array(z.string().regex(/^[A-Za-z0-9_]{1,32}$/, 'letters, digits and _ only'))
        .max(32)
        .optional(),
    /** Skipped when syncing the prod catalog branch (mirrors app install scripts). */
    internal: z.boolean().default(false),
    provisioning: vmProvisioningSchema,
    resources: vmBlueprintResourcesSchema,
    guest: vmBlueprintGuestSchema,
});

export type VMImageSource = z.infer<typeof vmImageSourceSchema>;
export type VMProvisioning = z.infer<typeof vmProvisioningSchema>;
export type VMBlueprintResources = z.infer<typeof vmBlueprintResourcesSchema>;
export type VMReadiness = z.infer<typeof vmReadinessSchema>;
export type VMBlueprint = z.infer<typeof vmBlueprintSchema>;

/** Where a blueprint row came from; admin rows are never touched by catalog syncs. */
export enum VMBlueprintSource {
    Catalog = 'catalog',
    Admin = 'admin',
}

// What the main server serves to clients / the admin UI (the row's effective,
// validated document plus provenance).
export interface VMBlueprintRecord {
    blueprintId: string;
    source: VMBlueprintSource;
    document: VMBlueprint;
    /** True when an admin override is layered over the synced document. */
    overridden: boolean;
    enabled: boolean;
    hidden: boolean;
    /** Admin-curated promotion flag; recommended blueprints sort first within their category. */
    recommended: boolean;
    /** Set (and the blueprint auto-disabled) when document+override no longer validates after a sync. */
    validationError: string | null;
    /** Catalog rows that disappeared from the repo; excluded from user-facing lists. */
    removedFromCatalog: boolean;
    updatedAt: Date;
}

// Admin management view: every row regardless of visibility, with provenance.
// `document` is the effective (document + override) blueprint, or null when
// the merge no longer validates.
export interface VMBlueprintAdminRecord {
    blueprintId: string;
    source: VMBlueprintSource;
    document: VMBlueprint | null;
    overridden: boolean;
    enabled: boolean;
    hidden: boolean;
    recommended: boolean;
    validationError: string | null;
    removedFromCatalog: boolean;
    lastCatalogSync: Date | null;
    updatedAt: Date;
}

/**
 * Completed installs per blueprint over a window — what orders the "Most
 * popular this month" grid. Blueprints nobody has installed are absent rather
 * than present with 0, so callers must treat a missing entry as no installs.
 */
export interface VMBlueprintPopularity {
    blueprintId: string;
    installs: number;
}

export interface VMBlueprintCatalogStatus {
    total: number;
    /** Enabled, not hidden, not removed, validating — what end users see. */
    visible: number;
    disabled: number;
    hidden: number;
    removedFromCatalog: number;
    invalid: number;
    adminAuthored: number;
    lastSync: Date | null;
}

export interface AdminVMBlueprintsResponse {
    blueprints: VMBlueprintAdminRecord[];
    status: VMBlueprintCatalogStatus;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Layer an admin override onto a synced catalog document: objects deep-merge,
 * arrays and primitives replace, and a `null` override value REMOVES the key
 * (no blueprint field is nullable, so null is unambiguous). The result must
 * be re-validated with vmBlueprintSchema before use — a resync can change the
 * document under an override.
 */
export function applyBlueprintOverride(
    document: Record<string, unknown>,
    override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
    if (!override) return document;

    const merged: Record<string, unknown> = { ...document };
    for (const [key, value] of Object.entries(override)) {
        if (value === null) {
            delete merged[key];
        } else if (isPlainObject(value) && isPlainObject(merged[key])) {
            merged[key] = applyBlueprintOverride(merged[key] as Record<string, unknown>, value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * Inverse of applyBlueprintOverride: the minimal override that turns
 * `document` (the synced catalog blueprint) into `edited` (what the admin
 * saved). Returns null when they match — i.e. the edit reverts to catalog.
 * Round-trip invariant: applyBlueprintOverride(document, override) deep-equals
 * `edited` (see the unit tests).
 */
export function computeBlueprintOverride(
    document: Record<string, unknown>,
    edited: Record<string, unknown>,
): Record<string, unknown> | null {
    const override: Record<string, unknown> = {};

    for (const [key, editedValue] of Object.entries(edited)) {
        const documentValue = document[key];
        if (isPlainObject(editedValue) && isPlainObject(documentValue)) {
            const nested = computeBlueprintOverride(documentValue, editedValue);
            if (nested) override[key] = nested;
        } else if (JSON.stringify(editedValue) !== JSON.stringify(documentValue)) {
            override[key] = editedValue;
        }
    }
    // Keys the edit removed -> null ("remove") entries.
    for (const key of Object.keys(document)) {
        if (!(key in edited)) override[key] = null;
    }

    return Object.keys(override).length > 0 ? override : null;
}

/**
 * Blueprint CPU-feature gate: which of `required` the host CPU lacks. Host
 * flags come from /proc/cpuinfo. An empty or unknown host list fails OPEN
 * (returns []) — the gate is a visibility filter and must never empty the
 * catalog when flags were never collected (older local versions, non-Linux
 * dev hosts); the real stop is the install pipeline's re-check on the host.
 */
export function missingCpuFeatures(hostFlags: string[] | null | undefined, required: string[] | undefined): string[] {
    if (!required?.length || !hostFlags?.length) return [];
    const available = new Set(hostFlags.map((flag) => flag.toLowerCase()));
    return required.filter((flag) => !available.has(flag.toLowerCase()));
}

/**
 * First-user names that collide with accounts or groups already baked into
 * Linux cloud images. cloud-init cannot create these (e.g. `root` already
 * exists, and Ubuntu ships with root logins disabled), so the machine comes
 * up unreachable. Protective, not exhaustive.
 */
export const RESERVED_LINUX_USERNAMES = new Set([
    'root',
    'daemon',
    'bin',
    'sys',
    'sync',
    'games',
    'man',
    'lp',
    'mail',
    'news',
    'uucp',
    'proxy',
    'www-data',
    'backup',
    'list',
    'irc',
    'gnats',
    'nobody',
    'systemd-network',
    'systemd-resolve',
    'systemd-timesync',
    'messagebus',
    'syslog',
    '_apt',
    'tss',
    'uuidd',
    'tcpdump',
    'sshd',
    'pollinate',
    'landscape',
    'fwupd-refresh',
    'usbmux',
    'dnsmasq',
    'polkitd',
    'dhcpcd',
    // Baked-in group names — the first user's primary group shares its name,
    // so these collide at useradd time as well.
    'adm',
    'sudo',
    'staff',
    'users',
    'wheel',
    'operator',
    'admin',
    'ubuntu',
]);

/** Account names Windows Setup refuses or that collide with built-ins. */
export const RESERVED_WINDOWS_USERNAMES = new Set([
    'administrator',
    'guest',
    'system',
    'defaultaccount',
    'wdagutilityaccount',
]);
