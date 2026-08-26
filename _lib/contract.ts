// Backend "contract" checks the Zod schema cannot express: a blueprint can be
// structurally valid yet name a template, icon, or version range that the
// install pipeline can't honour. These checks fail fast in CI instead of at
// sync time (where a bad row is silently disabled) or at install time (on a
// real machine).
//
// The template allowlists are hand-maintained mirrors of the backend. Keep them
// in sync when the backend adds a template. Sources of truth:
//   - cloud-init:    hexos-platform  packages/backend/src/lib/cloudInitSeed.ts   (USER_DATA_TEMPLATES)
//   - answer-file:   hexos-platform  packages/backend/src/lib/autounattend.ts    (ANSWER_FILE_TEMPLATES)
//   - installer-iso: hexos-platform  packages/backend/src/lib/installerSeed.ts   (INSTALLER_SEED_TEMPLATES)

import { sourceDigests, type VMBlueprint } from "./vm-blueprint.schema";

// A backend that requires sha256 on every source rejects a sha512-only
// document at sync time, which sets validationError and silently disables the
// row. Gating such blueprints behind ">=" this version would keep them hidden
// on those servers instead of broken on them.
//
// Deliberately empty, and not a TODO: digest-algorithm support landed in the
// same unreleased change as VM provisioning itself, so no deployed backend can
// sync this catalog without understanding sha512 — there is no window to gate.
// Set it only if the two ever diverge (a backend shipping blueprint sync but
// not sha512), which would be a regression, not a rollout.
export const MIN_SHA512_TRUENAS_VERSION = "";

export const KNOWN_CLOUD_INIT_TEMPLATES = new Set(["linux-default"]);

// Machine-config templates, and the delivery mechanism each one requires. A
// mismatch is silent at runtime: the guest simply never sees the document and
// boots unconfigured, so it is checked here rather than left to an install test.
export const KNOWN_MACHINE_CONFIG_TEMPLATES = new Map<string, "fw-cfg" | "config-drive">([
  // Every template delivers by config-drive, including the two Ignition guests.
  // fw-cfg works on every train (verified — see machine-config-strategy.md) but
  // the document would ride in the QEMU command line, where a phone-home token
  // is visible in `ps` and cannot be scrubbed after install: command_line_args
  // is persisted and re-rendered into the domain XML on every boot. Ignition
  // reads a config drive only on the 'openstack' platform, so both blueprints
  // pin the openstack image variant rather than the qemu one.
  //
  // talos-nocloud is NOT here yet: a Talos node rejects a partial machine
  // config, and a complete one carries the cluster's PKI (Talos API / etcd /
  // Kubernetes CAs plus the bootstrap token). Who generates and holds that key
  // is an open decision, so no template exists in hexos-platform and this
  // allowlist must not pretend otherwise — talos.json stays in _pending/.
  ["fcos-ignition", "config-drive"],
  ["flatcar-ignition", "config-drive"],
]);
export const KNOWN_ANSWER_FILE_TEMPLATES = new Set(["win11-pro", "win10-pro"]);
export const KNOWN_INSTALLER_SEED_TEMPLATES = new Set([
  "ubuntu-desktop-autoinstall",
  "fedora-workstation-kickstart",
  "fedora-kde-kickstart",
  "opensuse-agama-profile",
  "bazzite-kickstart",
  "mint-preseed",
  "zorin-preseed",
  "pop-live-exec",
  "omarchy-autoinstall",
  "cachyos-headless",
  "fygoos-initrd-exec",
  "steamos-repair",
]);

// Installer-image templates are installer-seed templates that additionally
// name the guest's fixed built-in account and drive the powerOffForMediaEject
// flow — only these may ride the installer-image strategy.
export const KNOWN_INSTALLER_IMAGE_TEMPLATES = new Set(["steamos-repair"]);
// The category vocabulary is enforced HERE (CI error) rather than as an enum in
// the schema: sync re-validates stored documents against the schema, so a hard
// enum would auto-hide blueprints whenever the catalog adds a category before
// the platform deploys. The UI groups these; unknown slugs land in "Other".
export const KNOWN_CATEGORIES = new Set(["server", "desktop", "appliance"]);

// Mirror of HEXOS_VM_CAPABILITIES in the platform's vm-blueprints.ts — the
// install-pipeline capabilities shipped backends can declare support for.
// Extend ONLY after the platform change ships (same rule as the template
// allowlists): a capability listed here before it exists upstream turns the
// check into a rubber stamp. Values are exact-match (no case folding) — the
// backend compares them verbatim.
export const KNOWN_VM_CAPABILITIES = new Set(["firstBoot"]);

// How many screenshots the detail-sheet gallery actually renders (the UI's
// ScreenshotViewer is handed a 5-item slice). Extra images cost repo size and
// are never seen.
export const SCREENSHOTS_SHOWN = 5;

// Mirrored icons live under _icons/ and are told apart from legacy
// frontend-bundled icon KEYS ("vms/ubuntu") by carrying an image extension —
// the exact gate the platform sync uses to decide what to resolve into a URL.
export const MIRRORED_ICON_FILE = /\.(svg|png|webp)$/i;

// parseRange (shared/eshtek/versions.ts) only reads tokens that start with a
// comparison operator; a range with none is silently "always in range".
const VERSION_RANGE_OP = /(?:^|\s)(?:>=|<=|>|<)\s*\d/;
// Common /proc/cpuinfo flag names worth gating on (the x86-64-v2/v3/v4
// microarchitecture levels plus frequent extras). A typo'd flag passes the
// schema but hides the blueprint on EVERY host, so unknown names warn rather
// than error — new flag names do appear as kernels evolve.
const KNOWN_CPU_FLAGS = new Set([
  // x86-64-v2
  "cx16", "lahf_lm", "popcnt", "sse4_1", "sse4_2", "ssse3",
  // x86-64-v3
  "abm", "avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "movbe", "xsave",
  // x86-64-v4
  "avx512bw", "avx512cd", "avx512dq", "avx512f", "avx512vl",
  // frequent extras
  "adx", "aes", "pclmulqdq", "pdpe1gb", "rdrand", "rdseed", "sha_ni", "sse2", "sse3", "svm", "vmx",
]);
// Legacy icon keys resolve like VMIcons ("vms/<slug>") against artwork bundled
// with the frontend; the mirrored form (MIRRORED_ICON_FILE) is preferred.
const LEGACY_ICON_KEY = /^vms\/[a-z0-9][a-z0-9-]*$/;
// A releasesUrl ending in an image/ISO/manifest filename is almost always the
// pinned artifact pasted twice, which defeats the point of the field.
const RELEASE_ARTIFACT = /\.(iso|img|qcow2|raw|vhd|vhdx|vmdk|xz|gz|bz2|zst|sha\d+|asc|sig)$/i;

/** Numeric-dot compare, e.g. "25.04.2.6" vs "25.10". Missing components read as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The version in the range's lower bound (">=25.04.2.6" -> "25.04.2.6"), or null. */
function lowerBound(range: string | undefined): string | null {
  const match = range?.match(/>=\s*([\d.]+)/);
  return match ? match[1] : null;
}

export interface ContractResult {
  errors: string[];
  warnings: string[];
}

export function checkContract(bp: VMBlueprint, filename: string): ContractResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // NB: the sync keys rows by the `id` FIELD, not the filename (the filename is
  // only used to fetch the file), so they legitimately differ — e.g. haos lives
  // in home-assistant-os.json. We only nudge when they diverge.
  const stem = filename.replace(/\.json$/, "");
  if (bp.id !== stem) {
    warnings.push(`id "${bp.id}" differs from the filename stem "${stem}" — allowed, but keeping them equal is the convention`);
  }

  const p = bp.provisioning;
  if (p.strategy === "cloud-init" && !KNOWN_CLOUD_INIT_TEMPLATES.has(p.cloudInit.userDataTemplate)) {
    errors.push(
      `unknown cloud-init template "${p.cloudInit.userDataTemplate}" — the backend ships only: ${[...KNOWN_CLOUD_INIT_TEMPLATES].join(", ")}`,
    );
  }
  if (p.strategy === "answer-file") {
    if (!KNOWN_ANSWER_FILE_TEMPLATES.has(p.answerFile.template)) {
      errors.push(
        `unknown answer-file template "${p.answerFile.template}" — the backend ships only: ${[...KNOWN_ANSWER_FILE_TEMPLATES].join(", ")}`,
      );
    }
    for (const m of p.extraMedia) {
      if (!m.sha256 && !m.sha512) {
        warnings.push(`extraMedia "${m.id}" has no sha256 or sha512 — the ISO will be attached without integrity verification`);
      }
    }
  }
  if (p.strategy === "machine-config") {
    const expected = KNOWN_MACHINE_CONFIG_TEMPLATES.get(p.machineConfig.template);
    if (!expected) {
      errors.push(
        `unknown machineConfig.template "${p.machineConfig.template}" — the backend only renders: ${[...KNOWN_MACHINE_CONFIG_TEMPLATES.keys()].sort().join(", ")}`,
      );
    } else if (expected !== p.machineConfig.delivery) {
      errors.push(
        `machineConfig.template "${p.machineConfig.template}" requires delivery "${expected}", not "${p.machineConfig.delivery}" — the wrong mechanism fails silently and the guest boots unconfigured`,
      );
    }
  }

  if (p.strategy === "installer-iso" && !KNOWN_INSTALLER_SEED_TEMPLATES.has(p.seed.template)) {
    errors.push(
      `unknown installer-seed template "${p.seed.template}" — the backend ships only: ${[...KNOWN_INSTALLER_SEED_TEMPLATES].join(", ")}`,
    );
  }
  if (p.strategy === "installer-image" && !KNOWN_INSTALLER_IMAGE_TEMPLATES.has(p.seed.template)) {
    errors.push(
      `unknown installer-image template "${p.seed.template}" — the backend ships only: ${[...KNOWN_INSTALLER_IMAGE_TEMPLATES].join(", ")}`,
    );
  }

  // Digest gate. The schema already guarantees at least one digest is present
  // and well-formed; what it cannot express is that sha512-only documents need
  // a backend new enough to understand them.
  if (p.strategy !== "answer-file" && MIN_SHA512_TRUENAS_VERSION) {
    const digests = sourceDigests(p.source);
    const sha512Only = digests.length === 1 && digests[0].algorithm === "sha512";
    if (sha512Only) {
      const gate = lowerBound(bp.truenasVersion);
      if (!gate) {
        errors.push(
          `source carries only a sha512 but truenasVersion has no ">=" lower bound — older backends reject the document at sync time and auto-disable it; gate it with ">=${MIN_SHA512_TRUENAS_VERSION}"`,
        );
      } else if (compareVersions(gate, MIN_SHA512_TRUENAS_VERSION) < 0) {
        errors.push(
          `source carries only a sha512 but truenasVersion allows ${gate}, older than ${MIN_SHA512_TRUENAS_VERSION} (first release with digest-algorithm support) — raise the lower bound`,
        );
      }
    }
  }

  // Every blueprint says where its next version comes from. The schema leaves
  // releasesUrl optional (admin-authored rows and older documents predate it);
  // the catalog requires it, because the alternative is the next person bumping
  // this file guessing at a URL — the exact path that produces `-latest` links
  // and invented digests.
  if (!p.source.releasesUrl) {
    errors.push(
      `source.releasesUrl is missing — name the page that lists this project's releases and their published digests (a directory index if there is one, otherwise the releases page)`,
    );
  } else if (RELEASE_ARTIFACT.test(p.source.releasesUrl)) {
    warnings.push(
      `source.releasesUrl "${p.source.releasesUrl}" points at a file rather than a page — it should be the listing you read to discover a NEWER version, not the artifact this blueprint already pins`,
    );
  }

  if (bp.category && !KNOWN_CATEGORIES.has(bp.category)) {
    errors.push(
      `unknown category "${bp.category}" — allowed values: ${[...KNOWN_CATEGORIES].join(", ")} (extend KNOWN_CATEGORIES deliberately when adding one)`,
    );
  }

  // Capability declarations are a closed vocabulary this repo controls, unlike
  // cpuFeatures' open kernel-flag namespace — an unknown value is either a typo
  // (hides the blueprint on every up-to-date host) or a capability that hasn't
  // shipped upstream yet, and both are errors.
  for (const capability of bp.requiredCapabilities ?? []) {
    if (!KNOWN_VM_CAPABILITIES.has(capability)) {
      errors.push(
        `requiredCapabilities value "${capability}" isn't a shipped capability — allowed values: ${[...KNOWN_VM_CAPABILITIES].join(", ")} (extend KNOWN_VM_CAPABILITIES only after the platform change ships)`,
      );
    }
  }
  // The declaration is the whole point of the gate: a blueprint using
  // first-boot injection without declaring it installs "successfully" on
  // backends that predate the feature — for OpenWRT that means booting a live
  // DHCP server at 192.168.1.1 on the user's LAN.
  const usesFirstBoot = p.strategy === "image" && p.firstBoot !== undefined;
  const declaresFirstBoot = (bp.requiredCapabilities ?? []).includes("firstBoot");
  if (usesFirstBoot && !declaresFirstBoot) {
    errors.push(
      `provisioning.firstBoot is set but requiredCapabilities doesn't declare "firstBoot" — backends without first-boot support would install this blueprint silently unconfigured`,
    );
  } else if (!usesFirstBoot && declaresFirstBoot) {
    warnings.push(
      `requiredCapabilities declares "firstBoot" but provisioning has no firstBoot profile — harmless over-gating that hides the blueprint from hosts that could run it`,
    );
  }

  for (const flag of bp.cpuFeatures ?? []) {
    if (!KNOWN_CPU_FLAGS.has(flag.toLowerCase())) {
      warnings.push(
        `cpuFeatures flag "${flag}" isn't a commonly known /proc/cpuinfo flag — double-check the spelling (a typo'd flag hides the blueprint on every host)`,
      );
    }
  }

  if (bp.truenasVersion && !VERSION_RANGE_OP.test(bp.truenasVersion)) {
    warnings.push(
      `truenasVersion "${bp.truenasVersion}" has no comparison operator (>=, >, <=, <) — it will be treated as no version gate at all`,
    );
  }

  // Screenshots ship IN this repo and the sync resolves them against the
  // branch's raw-GitHub base, so a path that leaves the repo resolves to
  // something outside the catalog — reject it here rather than serving it.
  // Absolute URLs stay legal (the schema accepts the resolved form), but a
  // catalog file authoring one means the image is not mirrored after all.
  for (const shot of bp.screenshots) {
    if (/^https?:\/\//.test(shot)) {
      warnings.push(
        `screenshot "${shot}" is an absolute URL — catalog files carry repo-relative paths so the image is mirrored here and cannot rot upstream`,
      );
    } else if (shot.startsWith("/") || shot.split("/").includes("..")) {
      errors.push(`screenshot "${shot}" must be a path relative to the repo root, with no "/" prefix and no ".." segments`);
    }
  }
  if (bp.screenshots.length === 0) {
    warnings.push(`no screenshots — the detail sheet renders without a gallery`);
  } else if (bp.screenshots.length > SCREENSHOTS_SHOWN) {
    warnings.push(
      `${bp.screenshots.length} screenshots, but the detail sheet gallery shows the first ${SCREENSHOTS_SHOWN} — the rest are dead weight in the repo`,
    );
  }

  // Icons ride in this repo too (under _icons/), resolved by the same sync. A
  // legacy frontend icon key stays legal — VMs installed before icons moved
  // here persisted those keys — but a NEW blueprint authored with one only
  // renders once the platform bundles that artwork, which is the coupling the
  // mirrored form exists to break.
  if (!bp.icon) {
    warnings.push(`no icon — catalog cards render the generic custom tile`);
  } else if (/^https?:\/\//.test(bp.icon)) {
    warnings.push(
      `icon "${bp.icon}" is an absolute URL — catalog files carry repo-relative paths so the icon is mirrored here and cannot rot upstream`,
    );
  } else if (!MIRRORED_ICON_FILE.test(bp.icon)) {
    warnings.push(
      LEGACY_ICON_KEY.test(bp.icon)
        ? `icon "${bp.icon}" is a legacy frontend icon key — it only renders if the platform already bundles that artwork; prefer mirroring an svg under _icons/`
        : `icon "${bp.icon}" is neither a mirrored asset path (_icons/<name>.svg) nor a legacy "vms/<slug>" key — the UI will fall back to the custom tile`,
    );
  } else if (bp.icon.startsWith("/") || bp.icon.split("/").includes("..")) {
    errors.push(`icon "${bp.icon}" must be a path relative to the repo root, with no "/" prefix and no ".." segments`);
  }

  if (!bp.website) {
    warnings.push(`no website — the detail sheet renders without its "Website" button`);
  }

  return { errors, warnings };
}
