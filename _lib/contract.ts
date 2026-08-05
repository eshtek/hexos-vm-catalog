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

import type { VMBlueprint } from "./vm-blueprint.schema";

export const KNOWN_CLOUD_INIT_TEMPLATES = new Set(["linux-default"]);
export const KNOWN_ANSWER_FILE_TEMPLATES = new Set(["win11-pro", "win10-pro"]);
export const KNOWN_INSTALLER_SEED_TEMPLATES = new Set([
  "ubuntu-desktop-autoinstall",
  "fedora-workstation-kickstart",
  "bazzite-kickstart",
  "mint-preseed",
  "zorin-preseed",
  "pop-live-exec",
]);
// The category vocabulary is enforced HERE (CI error) rather than as an enum in
// the schema: sync re-validates stored documents against the schema, so a hard
// enum would auto-hide blueprints whenever the catalog adds a category before
// the platform deploys. The UI groups these; unknown slugs land in "Other".
export const KNOWN_CATEGORIES = new Set(["server", "desktop", "appliance"]);

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
// Icon keys resolve like VMIcons ("vms/<slug>"); anything else falls back to
// the OS-derived icon in the UI — a lint, not a hard failure.
const ICON_KEY = /^vms\/[a-z0-9][a-z0-9-]*$/;

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
      if (!m.sha256) {
        warnings.push(`extraMedia "${m.id}" has no sha256 — the ISO will be attached without integrity verification`);
      }
    }
  }
  if (p.strategy === "installer-iso" && !KNOWN_INSTALLER_SEED_TEMPLATES.has(p.seed.template)) {
    errors.push(
      `unknown installer-seed template "${p.seed.template}" — the backend ships only: ${[...KNOWN_INSTALLER_SEED_TEMPLATES].join(", ")}`,
    );
  }

  if (bp.category && !KNOWN_CATEGORIES.has(bp.category)) {
    errors.push(
      `unknown category "${bp.category}" — allowed values: ${[...KNOWN_CATEGORIES].join(", ")} (extend KNOWN_CATEGORIES deliberately when adding one)`,
    );
  }

  if (bp.icon && !ICON_KEY.test(bp.icon)) {
    warnings.push(`icon "${bp.icon}" doesn't match the "vms/<slug>" convention; the UI will fall back to the OS-derived icon if it can't resolve`);
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

  return { errors, warnings };
}
