// Validate every document this repo publishes — blueprints in the repo root and
// apps under apps/ — against the vendored schemas plus the backend contract
// checks. Exit non-zero on any error (warnings never fail the run). Run from
// this directory with: bun run validate
//
// This is a contributor convenience — the catalog sync in hexos-platform is the
// authoritative gate and re-validates with the same schemas at read time.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppContract, checkContract, MAX_RECOMMENDED_APPS, MIRRORED_ICON_FILE } from "./contract";
import { checkTests, readBlueprints } from "./tests";
import { type VMApp, vmAppSchema } from "./vm-app.schema";
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

const report = (file: string, errors: string[], warnings: string[]): void => {
  const mark = errors.length ? "✗" : warnings.length ? "⚠" : "✓";
  console.log(`${mark} ${file}`);
  for (const e of errors) console.log(`    error:   ${e}`);
  for (const w of warnings) console.log(`    warning: ${w}`);
  errorCount += errors.length;
  warningCount += warnings.length;
};
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

  report(file, errors, warnings);
}

// ── Apps ─────────────────────────────────────────────────────────────────────
// A separate pass rather than a second entry in the loop above: apps live in a
// subdirectory precisely so the blueprint sync (root *.json only) never sees
// them, and mixing the two here would blur the distinction the layout exists to
// make. The directory is optional — a catalog with no apps is valid.
const APPS_DIR = join(ROOT, "apps");
const appFiles = existsSync(APPS_DIR)
  ? readdirSync(APPS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .sort()
  : [];

const appIdToFile = new Map<string, string>();
let recommendedCount = 0;
let iconlessCount = 0;

if (appFiles.length > 0) console.log("");

for (const file of appFiles) {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(APPS_DIR, file), "utf8"));
  } catch (e) {
    errors.push(`invalid JSON: ${(e as Error).message}`);
  }

  if (raw !== undefined) {
    const parsed = vmAppSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? issue.path.join(".") : "(root)";
        errors.push(`${path}: ${issue.message}`);
      }
    } else {
      const app: VMApp = parsed.data;
      const prior = appIdToFile.get(app.id);
      if (prior) {
        errors.push(`duplicate id "${app.id}" — already used by ${prior}; the sync skips the duplicate`);
      } else {
        appIdToFile.set(app.id, file);
      }
      if (app.recommended) recommendedCount++;
      if (!app.icon) iconlessCount++;

      const contract = checkAppContract(app, file);
      errors.push(...contract.errors);
      warnings.push(...contract.warnings);

      // Same filesystem check the blueprint icons get, and for the same reason:
      // the sync only rewrites the path against the branch base, so a typo
      // surfaces as a broken image in the picker long after the fact.
      if (app.icon && !/^https?:\/\//.test(app.icon) && MIRRORED_ICON_FILE.test(app.icon) && !existsSync(join(ROOT, app.icon))) {
        errors.push(`icon "${app.icon}" does not exist in the repo — mirrored icons must be committed (see _icons/apps/)`);
      }
    }
  }

  report(`apps/${file}`, errors, warnings);
}

// Both of these are properties of the SET, reported once rather than blamed on
// whichever app happened to be validated last. Missing artwork is deliberately
// not a per-app warning: while the catalog has none, that would put a warning
// on every file and bury the ones that mean something.
if (iconlessCount > 0) {
  console.log(`⚠ apps/ (catalog-wide)`);
  console.log(
    `    warning: ${iconlessCount} of ${appFiles.length} apps have no icon — the picker renders a lettered tile for each; mirroring artwork under _icons/apps/ needs an ATTRIBUTION.md row per file`,
  );
  warningCount++;
}
if (recommendedCount > MAX_RECOMMENDED_APPS) {
  console.log(`⚠ apps/ (catalog-wide)`);
  console.log(
    `    warning: ${recommendedCount} apps are marked recommended, over the ${MAX_RECOMMENDED_APPS} the picker pre-checks comfortably — every one of them installs for a user who just clicks Continue`,
  );
  warningCount++;
}

// Every published blueprint has to appear in the README's tables. This is the
// step that has actually been skipped in practice — SteamOS shipped and was
// never listed, and four others before it — so it is checked here rather than
// left to the order-of-operations list in CLAUDE.md. An unlisted blueprint is
// invisible to anyone reading the repo, which is the only place its provenance
// is written down.
const readmePath = join(ROOT, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  const unlisted = [...idToFile.entries()]
    .filter(([, file]) => !readme.includes(`(${file})`))
    .map(([id, file]) => `${id} (${file})`);
  if (unlisted.length > 0) {
    console.log("");
    console.log("✗ README.md");
    for (const entry of unlisted) {
      console.log(`    error:   ${entry} is not listed in the README — add its row to the table for its category`);
    }
    errorCount += unlisted.length;
  }
}

// ── Test specs ───────────────────────────────────────────────────────────────
// `_tests/` is source: every published blueprint carries a spec that says how
// it is installed under test and what to assert, reviewed in the same PR as
// the blueprint. Results never live here (they go to the HexOS main server),
// so the checks are structural: suite present, every spec valid, one per
// blueprint, and the derivable half in step with the blueprint it tests.
const tests = checkTests(readBlueprints());
if (tests.present) {
  console.log("");
  console.log(`${tests.errors.length ? "✗" : tests.warnings.length ? "⚠" : "✓"} _tests/`);
  for (const e of tests.errors) console.log(`    error:   ${e}`);
  for (const w of tests.warnings) console.log(`    warning: ${w}`);
  errorCount += tests.errors.length;
  warningCount += tests.warnings.length;
}

console.log("");
console.log(
  `${files.length} blueprint(s) and ${appFiles.length} app(s) checked — ${errorCount} error(s), ${warningCount} warning(s)`,
);
process.exit(errorCount > 0 ? 1 : 0);
