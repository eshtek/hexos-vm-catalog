// Validate every blueprint JSON in the repo root against the vendored schema
// plus the backend contract checks. Exit non-zero on any error (warnings never
// fail the run). Run from this directory with: bun run validate
//
// This is a contributor convenience — the catalog sync in hexos-platform is the
// authoritative gate and re-validates with the same schema at read time.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkContract, MIRRORED_ICON_FILE } from "./contract";
import { type VMBlueprint, vmBlueprintSchema } from "./vm-blueprint.schema";

// This file lives in _lib/; blueprints live one level up in the repo root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Match the sync's file selection exactly: root-level *.json, excluding
// "_"-prefixed files (interface/vms.ts syncVMBlueprintCatalog).
const files = readdirSync(ROOT)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .sort();

if (files.length === 0) {
  console.error("no blueprint JSON files found in repo root");
  process.exit(1);
}

let errorCount = 0;
let warningCount = 0;
// The sync rejects a second blueprint that reuses an id; catch it here too.
const idToFile = new Map<string, string>();

for (const file of files) {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch (e) {
    errors.push(`invalid JSON: ${(e as Error).message}`);
  }

  if (raw !== undefined) {
    const parsed = vmBlueprintSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? issue.path.join(".") : "(root)";
        errors.push(`${path}: ${issue.message}`);
      }
    } else {
      const bp: VMBlueprint = parsed.data;
      const prior = idToFile.get(bp.id);
      if (prior) {
        errors.push(`duplicate id "${bp.id}" — already used by ${prior}; the sync skips the duplicate`);
      } else {
        idToFile.set(bp.id, file);
      }
      const contract = checkContract(bp, file);
      errors.push(...contract.errors);
      warnings.push(...contract.warnings);

      // Mirrored screenshots live in THIS repo, so a path typo is checkable
      // here and nowhere else: the sync only rewrites the path against the
      // branch base, and a missing file surfaces as a broken image in the
      // detail sheet long after the fact. (checkContract can't do this — it is
      // a pure function shared with the platform, with no filesystem access.)
      for (const shot of bp.screenshots) {
        if (/^https?:\/\//.test(shot)) continue;
        if (!existsSync(join(ROOT, shot))) {
          errors.push(`screenshot "${shot}" does not exist in the repo — mirrored images must be committed alongside the blueprint`);
        }
      }

      // Same for a mirrored icon; legacy frontend keys and absolute URLs name
      // nothing in this repo, so only extension-bearing relative paths are
      // checkable here.
      if (bp.icon && !/^https?:\/\//.test(bp.icon) && MIRRORED_ICON_FILE.test(bp.icon) && !existsSync(join(ROOT, bp.icon))) {
        errors.push(`icon "${bp.icon}" does not exist in the repo — mirrored icons must be committed (see _icons/)`);
      }
    }
  }

  const mark = errors.length ? "✗" : warnings.length ? "⚠" : "✓";
  console.log(`${mark} ${file}`);
  for (const e of errors) console.log(`    error:   ${e}`);
  for (const w of warnings) console.log(`    warning: ${w}`);

  errorCount += errors.length;
  warningCount += warnings.length;
}

console.log("");
console.log(`${files.length} blueprint(s) checked — ${errorCount} error(s), ${warningCount} warning(s)`);
process.exit(errorCount > 0 ? 1 : 0);
