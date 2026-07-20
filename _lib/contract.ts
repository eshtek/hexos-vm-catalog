// Backend "contract" checks the Zod schema cannot express: a blueprint can be
// structurally valid yet name a template, icon, or version range that the
// install pipeline can't honour. These checks fail fast in CI instead of at
// sync time (where a bad row is silently disabled) or at install time (on a
// real machine).
//
// The template allowlists are hand-maintained mirrors of the backend. Keep them
// in sync when the backend adds a template. Sources of truth:
//   - cloud-init:  hexos-platform  packages/backend/src/lib/cloudInitSeed.ts   (USER_DATA_TEMPLATES)
//   - answer-file: hexos-platform  packages/backend/src/lib/autounattend.ts    (ANSWER_FILE_TEMPLATES)

import type { VMBlueprint } from "./vm-blueprint.schema";

export const KNOWN_CLOUD_INIT_TEMPLATES = new Set(["linux-default"]);
export const KNOWN_ANSWER_FILE_TEMPLATES = new Set(["win11-pro"]);

// parseRange (shared/eshtek/versions.ts) only reads tokens that start with a
// comparison operator; a range with none is silently "always in range".
const VERSION_RANGE_OP = /(?:^|\s)(?:>=|<=|>|<)\s*\d/;
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

  if (bp.icon && !ICON_KEY.test(bp.icon)) {
    warnings.push(`icon "${bp.icon}" doesn't match the "vms/<slug>" convention; the UI will fall back to the OS-derived icon if it can't resolve`);
  }

  if (bp.truenasVersion && !VERSION_RANGE_OP.test(bp.truenasVersion)) {
    warnings.push(
      `truenasVersion "${bp.truenasVersion}" has no comparison operator (>=, >, <=, <) — it will be treated as no version gate at all`,
    );
  }

  return { errors, warnings };
}
