// The catalog's test specs (`_tests/`): list them, generate the missing ones,
// and the checks validate.ts runs over them. Run from this directory:
//
//   bun tests.ts                # table: every blueprint, its spec (or the gap), ceiling, checks
//   bun tests.ts --generate     # write _tests/spec/<id>.json for every blueprint without one
//   bun tests.ts --generate --force   # regenerate the derivable fields of EVERY spec (keeps prose)
//
// A spec holds only what the blueprint document cannot say: how the install
// dialog is answered (as a SHAPE — never a value), the wall-clock ceiling,
// which assertions apply, and what a reviewer should look for on the console
// frame. Everything derivable is derived here from the same rules the sweep
// harness uses (hexos-platform packages/dev/scripts/vm-catalog-sweep/plan.py),
// so a spec cannot drift from its blueprint.
//
// Results never live here. They are posted to the HexOS main server by the
// harness and read from the admin console; see the README.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type VMBlueprint, vmBlueprintSchema } from './vm-blueprint.schema';
import {
    type VMBlueprintTestSpec,
    type VMBlueprintTestSuite,
    vmBlueprintTestSpecSchema,
    vmBlueprintTestSuiteSchema,
} from './vm-blueprint-tests.schema';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TESTS_DIR = join(ROOT, '_tests');
export const SPEC_DIR = join(TESTS_DIR, 'spec');
export const SUITE_PATH = join(TESTS_DIR, 'suite.json');

// installer-iso templates that embed the answers in the installer copy instead
// of a companion seed volume (no .{slug}-seed.iso to assert on).
const PRESEED_CARRIER_TEMPLATES = new Set(['mint-preseed', 'zorin-preseed']);
// Assertion D/G reads the stopped guest's disk: Linux guests we created an account on.
const GUEST_READ_STRATEGIES = new Set(['cloud-init', 'installer-iso', 'installer-image', 'machine-config']);
// Assertion G (stop/start steady state): every seed-on-the-boot-bus strategy,
// plus one representative of every other strategy.
const REBOOT_STRATEGIES = new Set(['cloud-init', 'machine-config']);
const REBOOT_SET = new Set(['cachyos', 'steamos', 'haos', 'windows-11']);

export function readBlueprints(): Map<string, { file: string; blueprint: VMBlueprint }> {
    const out = new Map<string, { file: string; blueprint: VMBlueprint }>();
    for (const file of readdirSync(ROOT).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()) {
        const parsed = vmBlueprintSchema.safeParse(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
        if (parsed.success) out.set(parsed.data.id, { file, blueprint: parsed.data });
    }
    return out;
}

export function readSuite(): { suite: VMBlueprintTestSuite | null; errors: string[] } {
    if (!existsSync(SUITE_PATH)) return { suite: null, errors: [] };
    try {
        const parsed = vmBlueprintTestSuiteSchema.safeParse(JSON.parse(readFileSync(SUITE_PATH, 'utf8')));
        if (!parsed.success) {
            return {
                suite: null,
                errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
            };
        }
        return { suite: parsed.data, errors: [] };
    } catch (e) {
        return { suite: null, errors: [`invalid JSON: ${(e as Error).message}`] };
    }
}

export function readSpecs(): Map<string, { file: string; spec: VMBlueprintTestSpec | null; errors: string[] }> {
    const out = new Map<string, { file: string; spec: VMBlueprintTestSpec | null; errors: string[] }>();
    if (!existsSync(SPEC_DIR)) return out;
    for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()) {
        const id = file.replace(/\.json$/, '');
        try {
            const raw = JSON.parse(readFileSync(join(SPEC_DIR, file), 'utf8'));
            const parsed = vmBlueprintTestSpecSchema.safeParse(raw);
            if (!parsed.success) {
                out.set(id, {
                    file,
                    spec: null,
                    errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
                });
            } else {
                out.set(id, { file, spec: parsed.data, errors: [] });
            }
        } catch (e) {
            out.set(id, { file, spec: null, errors: [`invalid JSON: ${(e as Error).message}`] });
        }
    }
    return out;
}

/** The derivable half of a spec, from the blueprint alone. */
export function deriveSpec(blueprint: VMBlueprint): Omit<VMBlueprintTestSpec, 'frameReview' | 'knownIssue' | 'ceilingMinutes'> {
    const strategy = blueprint.provisioning.strategy;
    const options =
        strategy === 'cloud-init' || strategy === 'installer-iso'
            ? { username: true, password: true, userIso: false }
            : strategy === 'answer-file'
              ? { username: true, password: true, userIso: true }
              : strategy === 'machine-config' || strategy === 'installer-image'
                ? { username: false, password: true, userIso: false }
                : { username: false, password: false, userIso: false };
    const seedTemplate = strategy === 'installer-iso' ? blueprint.provisioning.seed.template : undefined;
    const preseedCarrier = seedTemplate !== undefined && PRESEED_CARRIER_TEMPLATES.has(seedTemplate);
    const seed =
        strategy === 'cloud-init'
            ? { dtype: 'RAW' as const, order: 2, label: 'cidata' }
            : strategy === 'machine-config'
              ? { dtype: 'RAW' as const, order: 2, label: 'config-2' }
              : strategy === 'installer-image'
                ? { dtype: 'CDROM' as const, order: 3 }
                : strategy === 'installer-iso' && !preseedCarrier
                  ? { dtype: 'CDROM' as const, order: 2 }
                  : null;
    return {
        blueprintId: blueprint.id,
        strategy,
        options,
        checks: {
            guestRead: GUEST_READ_STRATEGIES.has(strategy),
            reboot: REBOOT_STRATEGIES.has(strategy) || REBOOT_SET.has(blueprint.id),
            seed,
        },
    };
}

/** What validate.ts enforces over `_tests/` — empty when the directory is absent. */
export function checkTests(blueprints: Map<string, { file: string; blueprint: VMBlueprint }>): {
    errors: string[];
    warnings: string[];
    present: boolean;
} {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!existsSync(TESTS_DIR)) return { errors, warnings, present: false };

    const { suite, errors: suiteErrors } = readSuite();
    if (!existsSync(SUITE_PATH)) errors.push('_tests/suite.json is missing');
    for (const e of suiteErrors) errors.push(`_tests/suite.json ${e}`);

    const specs = readSpecs();
    for (const [id, { file, spec, errors: specErrors }] of specs) {
        for (const e of specErrors) errors.push(`_tests/spec/${file} ${e}`);
        if (!spec) continue;
        if (spec.blueprintId !== id) errors.push(`_tests/spec/${file}: blueprintId "${spec.blueprintId}" does not match the file name`);
        const bp = blueprints.get(spec.blueprintId);
        if (!bp) {
            errors.push(`_tests/spec/${file}: no blueprint "${spec.blueprintId}" in the repo root`);
            continue;
        }
        const derived = deriveSpec(bp.blueprint);
        if (spec.strategy !== derived.strategy) {
            errors.push(`_tests/spec/${file}: strategy "${spec.strategy}" but the blueprint provisions with "${derived.strategy}"`);
        }
        if (JSON.stringify(spec.options) !== JSON.stringify(derived.options)) {
            warnings.push(`_tests/spec/${file}: options differ from what the strategy implies (${JSON.stringify(derived.options)})`);
        }
        if (JSON.stringify(spec.checks.seed) !== JSON.stringify(derived.checks.seed)) {
            warnings.push(`_tests/spec/${file}: checks.seed differs from what the strategy implies (${JSON.stringify(derived.checks.seed)})`);
        }
        if (suite && spec.ceilingMinutes !== undefined && spec.ceilingMinutes < suite.ceilingMinutes[spec.strategy]) {
            warnings.push(`_tests/spec/${file}: ceilingMinutes ${spec.ceilingMinutes} is below the suite's ${suite.ceilingMinutes[spec.strategy]} for ${spec.strategy}`);
        }
    }
    for (const [id, { file }] of blueprints) {
        if (!specs.has(id)) errors.push(`${file}: no test spec — run \`bun run generate-tests\` (writes _tests/spec/${id}.json)`);
    }
    return { errors, warnings, present: true };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
    const args = new Set(process.argv.slice(2));
    const blueprints = readBlueprints();
    const specs = readSpecs();

    if (args.has('--generate')) {
        mkdirSync(SPEC_DIR, { recursive: true });
        let written = 0;
        for (const [id, { blueprint }] of blueprints) {
            const existing = specs.get(id)?.spec;
            if (existing && !args.has('--force')) continue;
            const derived = deriveSpec(blueprint);
            // Prose and the ceiling are the human half; regeneration keeps them.
            const spec: VMBlueprintTestSpec = {
                ...derived,
                ...(existing?.ceilingMinutes !== undefined ? { ceilingMinutes: existing.ceilingMinutes } : {}),
                ...(existing?.frameReview ? { frameReview: existing.frameReview } : {}),
                ...(existing?.knownIssue ? { knownIssue: existing.knownIssue } : {}),
            };
            writeFileSync(join(SPEC_DIR, `${id}.json`), `${JSON.stringify(spec, null, 4)}\n`);
            written++;
        }
        console.log(`${written} spec(s) written to _tests/spec/`);
        process.exit(0);
    }

    const { suite } = readSuite();
    const width = Math.max(...[...blueprints.keys()].map((k) => k.length));
    for (const [id, { blueprint }] of blueprints) {
        const entry = specs.get(id);
        const spec = entry?.spec;
        const strategy = blueprint.provisioning.strategy;
        const ceiling = spec?.ceilingMinutes ?? suite?.ceilingMinutes[strategy];
        const flags = spec
            ? `${spec.checks.guestRead ? 'guest ' : ''}${spec.checks.reboot ? 'reboot ' : ''}${spec.checks.seed ? `seed=${spec.checks.seed.dtype}` : 'no-seed'}`
            : entry
              ? `INVALID (${entry.errors[0]})`
              : 'NO SPEC';
        console.log(`${id.padEnd(width)}  ${strategy.padEnd(16)}  ${String(ceiling ?? '—').padStart(3)}m  ${flags}${spec?.knownIssue ? `  — ${spec.knownIssue}` : ''}`);
    }
    const { errors, warnings } = checkTests(blueprints);
    for (const w of warnings) console.log(`⚠ ${w}`);
    for (const e of errors) console.log(`✗ ${e}`);
    process.exit(errors.length ? 1 : 0);
}
