// Check that every blueprint's source URL is still live, and optionally that
// its digest still matches. Run from this directory:
//
//   bun check-sources.ts              # HEAD only — fast, no downloads
//   bun check-sources.ts --verify     # also download and verify every digest
//   bun check-sources.ts --verify --id openwrt
//   bun check-sources.ts --self-test  # prove the checker itself works, stall guard included
//
// Why this exists: the most common way a blueprint breaks is not a bad
// install, it is upstream moving the file. Canonical deletes superseded point
// releases from cdimage, Fedora rotates, AlmaLinux and Rocky prune old dailies,
// OpenWrt retires service releases. A blueprint that validated fine yesterday
// 404s today and the first person to notice is a user whose install failed.
// HEAD-ing every URL nightly catches that for the cost of a few dozen requests.

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigests, vmBlueprintSchema } from './vm-blueprint.schema';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const VERIFY = args.has('--verify');
const idFlag = process.argv.indexOf('--id');
const ONLY = idFlag !== -1 ? process.argv[idFlag + 1] : null;

interface Target {
    blueprint: string;
    label: string;
    url: string;
    digests: { algorithm: string; value: string }[];
}

/** Blueprints interpolate {version} into the URL; do the same here. */
function expand(url: string, version?: string): string {
    return version ? url.replaceAll('{version}', version) : url;
}

function collect(): Target[] {
    const targets: Target[] = [];
    for (const file of readdirSync(ROOT).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()) {
        const parsed = vmBlueprintSchema.safeParse(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
        if (!parsed.success) {
            console.log(`⚠ ${file}: does not validate — run \`bun run validate\` first; skipping`);
            continue;
        }
        const bp = parsed.data;
        if (ONLY && bp.id !== ONLY) continue;
        const p = bp.provisioning;
        // answer-file blueprints take a user-supplied ISO; there is no URL to check.
        if (p.strategy !== 'answer-file') {
            const src = p.source as { url: string; version?: string; sha256?: string; sha512?: string };
            targets.push({
                blueprint: bp.id,
                label: 'source',
                url: expand(src.url, src.version),
                digests: sourceDigests(src),
            });
        }
        const extraMedia = 'extraMedia' in p ? (p.extraMedia ?? []) : [];
        for (const m of extraMedia) {
            targets.push({ blueprint: bp.id, label: `extraMedia:${m.id}`, url: m.url, digests: sourceDigests(m) });
        }
    }
    return targets;
}

function formatBytes(n: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`;
}

// ── Stall guards ─────────────────────────────────────────────────────────────
// A mirror that accepts the connection and then goes quiet is worse than one
// that refuses it: without a guard the request waits forever, the run burns its
// whole job budget on one target, and the remaining blueprints are never
// checked at all. Neither number is arbitrary:
//
//  - HEAD is a metadata request that should answer in well under a second, so
//    it gets a flat deadline.
//  - A verify legitimately runs for minutes (7 GiB files), so a deadline would
//    be wrong; what it needs is a THROUGHPUT FLOOR. These are the same terms
//    the install pipeline's curl already uses on the host (--speed-limit 10240
//    --speed-time 120): under 10 KiB/s averaged over two minutes counts as
//    stalled. Keeping the two in step matters — a mirror this tool accepts
//    should be one an install can actually finish from.
const HEAD_TIMEOUT_MS = 30_000;
const STALL_MIN_BYTES_PER_SEC = 10 * 1024;
// --self-test drops to a 3s window so proving the guard works takes three
// seconds rather than two minutes. It exercises the same code path; only the
// patience changes.
const STALL_WINDOW_MS = Number(
    process.env.CHECK_SOURCES_STALL_WINDOW_MS ?? (process.argv.includes('--self-test') ? 3_000 : 120_000),
);

async function head(url: string): Promise<{ ok: boolean; detail: string }> {
    try {
        // Some mirrors reject HEAD; fall back to a zero-length ranged GET.
        const signal = AbortSignal.timeout(HEAD_TIMEOUT_MS);
        let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal });
        }
        const size = res.headers.get('content-length');
        const human = size ? formatBytes(Number(size)) : 'size unknown';
        if (res.status === 404 || res.status === 410) {
            return { ok: false, detail: `${res.status} — upstream removed this file; the version almost certainly moved` };
        }
        if (!res.ok && res.status !== 206) return { ok: false, detail: `HTTP ${res.status}` };
        return { ok: true, detail: human };
    } catch (e) {
        return { ok: false, detail: `unreachable: ${(e as Error).message}` };
    }
}

async function verify(url: string, digests: Target['digests']): Promise<{ ok: boolean; detail: string }> {
    if (digests.length === 0) return { ok: true, detail: 'no digest declared — nothing to verify' };
    const controller = new AbortController();
    let received = 0;
    let windowStart = 0;
    let stalled = false;
    // Checked on a timer rather than per chunk: a stream that delivers NOTHING
    // never runs the chunk handler, which is the exact case this has to catch.
    const floor = Math.round((STALL_MIN_BYTES_PER_SEC * STALL_WINDOW_MS) / 1000);
    const watchdog = setInterval(() => {
        if (received - windowStart < floor) {
            stalled = true;
            controller.abort();
            return;
        }
        windowStart = received;
    }, STALL_WINDOW_MS);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
        if (!res.ok || !res.body) return { ok: false, detail: `HTTP ${res.status}` };
        // One pass over the stream, every declared algorithm at once — same
        // shape as the install pipeline, so a mismatch here means a real one.
        const hashes = digests.map((d) => ({ ...d, hash: createHash(d.algorithm) }));
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            received += chunk.byteLength;
            for (const h of hashes) h.hash.update(chunk);
        }
        const bad = hashes
            .map((h) => ({ algorithm: h.algorithm, expected: h.value, actual: h.hash.digest('hex') }))
            .filter((r) => r.expected !== r.actual);
        if (bad.length) {
            return {
                ok: false,
                detail: bad.map((b) => `${b.algorithm} mismatch — expected ${b.expected}, got ${b.actual}`).join('; '),
            };
        }
        return { ok: true, detail: `${digests.map((d) => d.algorithm).join('+')} verified` };
    } catch (e) {
        if (stalled) {
            return {
                ok: false,
                detail:
                    `stalled after ${formatBytes(received)} — under ${STALL_MIN_BYTES_PER_SEC / 1024} KiB/s for ` +
                    `${STALL_WINDOW_MS / 1000}s. The mirror is answering but not serving; an install would fail here too`,
            };
        }
        return { ok: false, detail: `download failed: ${(e as Error).message}` };
    } finally {
        clearInterval(watchdog);
    }
}

async function selfTest(): Promise<number> {
    const cases: [string, string, boolean][] = [
        ['live URL', 'https://raw.githubusercontent.com/eshtek/hexos-vm-catalog/staging/README.md', true],
        ['missing URL', 'https://raw.githubusercontent.com/eshtek/hexos-vm-catalog/staging/definitely-not-here.iso', false],
    ];
    let failed = 0;
    for (const [name, url, expectOk] of cases) {
        const r = await head(url);
        const pass = r.ok === expectOk;
        console.log(`${pass ? '✓' : '✗'} self-test ${name}: ${r.detail}`);
        if (!pass) failed++;
    }

    // The stall guard, against a server that answers 200 with a content-length
    // and then sends nothing — the failure mode a plain fetch waits out forever.
    // Run with a short window (CHECK_SOURCES_STALL_WINDOW_MS) so the check takes
    // seconds; the guard itself is the same code path a real run uses.
    const server = Bun.serve({
        port: 0,
        fetch: () =>
            new Response(
                new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(1024));
                        // ...and then nothing, forever. Never closed.
                    },
                }),
                { headers: { 'content-length': '999999999' } },
            ),
    });
    const stallCase = await verify(`http://localhost:${server.port}/silent.img`, [
        { algorithm: 'sha256', value: 'a'.repeat(64) },
    ]);
    server.stop(true);
    const stallPass = !stallCase.ok && stallCase.detail.startsWith('stalled');
    console.log(`${stallPass ? '✓' : '✗'} self-test stalled mirror: ${stallCase.detail}`);
    if (!stallPass) failed++;

    return failed;
}

const targets = collect();
if (args.has('--self-test')) process.exit((await selfTest()) > 0 ? 1 : 0);

console.log(`checking ${targets.length} source URL(s)${VERIFY ? ' with full digest verification' : ''}\n`);
let failures = 0;
for (const t of targets) {
    const r = VERIFY ? await verify(t.url, t.digests) : await head(t.url);
    if (!r.ok) failures++;
    console.log(`${r.ok ? '✓' : '✗'} ${t.blueprint} (${t.label}) — ${r.detail}`);
    if (!r.ok) console.log(`    ${t.url}`);
}

console.log(`\n${targets.length} checked — ${failures} failure(s)`);
process.exit(failures > 0 ? 1 : 0);
