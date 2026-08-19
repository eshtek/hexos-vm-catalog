// Print what every blueprint is pinned to and where a newer version would be
// announced — the starting point for a version-bump pass. Run from this
// directory:
//
//   bun releases.ts                 # id, pinned version, releases page
//   bun releases.ts --pending       # include the _pending/ drafts
//   bun releases.ts --check         # also confirm each page still resolves
//   bun releases.ts --json          # machine-readable, for scripted bumps
//
// Why this is separate from check-sources.ts: that tool answers "is the file we
// pinned still there", which is a hard failure and runs nightly in CI. This one
// answers "what would we bump to", which is a human (or agent) reading vendor
// pages — no result of it can fail a build, so --check reports and exits 0.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigests, vmBlueprintSchema } from './vm-blueprint.schema';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_OUT = args.has('--json');

interface Row {
    id: string;
    name: string;
    file: string;
    pending: boolean;
    version: string;
    digests: string;
    releasesUrl: string | null;
}

function read(dir: string, pending: boolean): Row[] {
    const rows: Row[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()) {
        const parsed = vmBlueprintSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        // Drafts routinely carry "TODO" placeholders and fail the schema; they
        // are exactly the ones a bump pass cares about, so report them anyway.
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
            id: string;
            name: string;
            provisioning: { source: Record<string, string> };
        };
        const src = parsed.success ? (parsed.data.provisioning.source as Record<string, string>) : raw.provisioning.source;
        rows.push({
            id: raw.id,
            name: raw.name,
            file: pending ? `_pending/${file}` : file,
            pending,
            // user-iso sources have no version: the user brings the media.
            version: src.version ?? '—',
            // A draft's digest is often the literal "TODO"; say so rather than
            // reporting the algorithm as if a real value were in place.
            digests:
                sourceDigests(src)
                    .map((d) => (d.value === 'TODO' ? `${d.algorithm}:TODO` : d.algorithm))
                    .join('+') || '—',
            releasesUrl: src.releasesUrl ?? null,
        });
    }
    return rows;
}

const rows = [...read(ROOT, false), ...(args.has('--pending') ? read(join(ROOT, '_pending'), true) : [])];

if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
}

const width = (pick: (r: Row) => string) => Math.max(...rows.map((r) => pick(r).length));
const idWidth = width((r) => r.id);
const versionWidth = width((r) => r.version);

for (const r of rows) {
    const mark = r.pending ? '·' : ' ';
    console.log(
        `${mark} ${r.id.padEnd(idWidth)}  ${r.version.padEnd(versionWidth)}  ${r.digests.padEnd(6)}  ${r.releasesUrl ?? '(no releasesUrl — run `bun run validate`)'}`,
    );
}

if (CHECK) {
    console.log('');
    for (const r of rows) {
        if (!r.releasesUrl) continue;
        let detail: string;
        try {
            const res = await fetch(r.releasesUrl, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
            // 403/405 is routinely a bot filter (Microsoft's download page, S3
            // buckets with listing disabled), not a dead link — the page is
            // there for a person with a browser, which is who reads it.
            detail =
                res.status === 403 || res.status === 405
                    ? `⚠ HTTP ${res.status} — reachable, but blocks scripted requests; open it in a browser`
                    : res.ok
                      ? `✓ HTTP ${res.status}`
                      : `✗ HTTP ${res.status} — the vendor moved this page`;
        } catch (e) {
            detail = `✗ unreachable: ${(e as Error).message}`;
        }
        console.log(`${detail}  ${r.id} → ${r.releasesUrl}`);
    }
}
