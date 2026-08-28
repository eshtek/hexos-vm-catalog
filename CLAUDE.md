# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

`eshtek/hexos-vm-catalog` — the one-click VM catalog for HexOS. It publishes two
kinds of document: each root-level `*.json` is one **blueprint** (a VM to
deploy), and each `apps/*.json` is one **app** (optional software a desktop
install lays down last, the Ninite-style picker step). The HexOS backend syncs
this repo and re-validates every document against the real schema at read time,
so **the server is the authoritative gate; local validation is a convenience.**

The two are synced separately and must stay separable: the blueprint sync
ingests every non-underscore `*.json` in the ROOT and ignores directories, which
is the only reason apps can live here at all. Never move an app document to the
root — the blueprint sync would pick it up, fail to validate it as a blueprint,
and log an error every run.

Default branch is `staging`. `prod` feeds production.

## Commands

```bash
cd _lib
bun install
bun run validate        # schema + contract checks on every blueprint AND every app
bun run check-sources   # HEAD every source URL and resolve every app package id
bun run check-sources -- --apps     # only the app package ids
bun run check-sources -- --verify   # stream + verify every digest (~57 GiB transferred, nothing stored)
bun run releases        # pinned version + releases page per blueprint (--pending, --check, --json)
./fetch-checksums.sh    # print official checksums for _pending/ drafts
```

Run `bun run validate` before proposing any blueprint or app change.

## Hard rules

**Never invent a checksum, a download URL, or a package id.** Every
`sha256`/`sha512` in this repo must come from the publisher's own manifest, and
every URL must have been confirmed to exist. The same rule covers app
`targets`: resolve each winget id against a real manifest directory in
`microsoft/winget-pkgs` and each flatpak id against Flathub before the document
leaves `_pending/` — `bun run check-sources -- --apps` does exactly that, so
there is no excuse for a guessed one. A plausible-looking id is worse than a
missing app: it ships a picker entry that installs nothing, silently, for
everyone who ticks it. A fabricated digest fails at install time on a user's
machine; a fabricated URL is the same class of mistake. If a value cannot be
confirmed, write `"TODO"` and leave the draft in `_pending/` — that is the
correct outcome, not a failure.

**Take the digest the publisher signs, in whatever algorithm they publish it.**
Hashing the download yourself produces a valid-looking SHA-256 that attests to
nothing — only that the bytes didn't change after you fetched them. Several
publishers offer no SHA-256 at all: Debian's cloud images and openSUSE publish
a signed `SHA512SUMS`, and Flatcar's `DIGESTS` carries MD5, SHA-1 and SHA-512.
Use `sha512` there. Both fields are optional with at least one required, and
the install pipeline verifies every digest present — listing both is a stronger
claim, not a fallback chain.

**Every blueprint carries `source.releasesUrl`** — the page you open to find
out whether a newer version exists and what its published digest is. CI errors
without it. Prefer a directory index that lists versions *and* their checksum
manifest; fall back to a releases page when the publisher offers no index.
`bun run releases` prints the whole table, which is where a version-bump pass
starts. It is editorial metadata: nothing fetches it and no client renders it
(that is `isoHelpUrl`'s job, on user-iso sources only — do not conflate them).

**Never point a blueprint at a `-latest` URL.** AlmaLinux and Rocky publish
`...-latest.x86_64.qcow2` symlinks; using one makes the digest a lie within
weeks. Pin the dated filename. Bumping a version should be a visible commit
changing both the version and the digest.

**`_lib/vm-blueprint.schema.ts` and `_lib/vm-app.schema.ts` are vendored, not
authored here.** They are copies of `packages/shared/eshtek/vm-blueprints.ts`
and `packages/shared/eshtek/vm-apps.ts` in `hexos-platform`, refreshed together
by `bun run sync-schema`. Never hand-edit one to preview a schema change: the next
re-vendor silently reverts the edit, and because `_lib/validate.ts` runs the
contract checks against Zod's *parsed* output, a field the vendored copy no
longer knows is stripped before those checks see it — every blueprint then
fails at once. Land the change upstream, then re-vendor.

**Underscore-prefixed paths are invisible to the sync.** `_lib/` and
`_pending/` are ignored by both the catalog sync and the validator. That is
what makes `_pending/` a safe staging area — never "fix" a draft by moving it
to the root just to make it validate. `_pending/` is also gitignored: drafts
carry `TODO` digests and unverified URLs, so they stay on the machine that
wrote them and are never published from this public repo.

**Backend allowlists in `_lib/contract.ts` mirror what actually ships.** Do not
add a template name before the matching template exists in `hexos-platform`;
that turns the contract check into a rubber stamp and lets a blueprint reach
production naming a template that does not exist.

## Order of operations for a new app

1. Confirm both package ids exist (`bun run check-sources -- --apps` after writing
   the document, or by hand against winget-pkgs and Flathub).
2. Read the package's winget manifest for its `Scope`. A user-scope package
   cannot ride the SYSTEM install stage; record `"scope": "user"` so the
   pipeline defers it rather than discovering the failure on a user's machine.
3. Write `apps/<id>.json` with a `category` already in `KNOWN_APP_CATEGORIES`.
4. `bun run validate`.
5. Add the row to the README table, in its category section.

## Order of operations for a new blueprint

1. Land any needed seed/config template in `hexos-platform`.
2. Add its name to the relevant allowlist in `_lib/contract.ts`.
3. Confirm the download URL exists and fetch the official digest; record the
   listing you found them on as `source.releasesUrl`.
4. Move the blueprint from `_pending/` to the repo root.
5. Add the row to the README table (grouped by `category`); desktops also
   declare `apps.runtime` and carry it in the table's `Apps` column.
6. `bun run validate`, then test against staging.

Step 5 used to be step 6, and used to be the one that got skipped — four
blueprints shipped without ever appearing in the README, and SteamOS made five.
`bun run validate` now ERRORS on a blueprint with no README row, so it can no
longer be forgotten; it is listed before validate so the order matches how it
is actually caught.

## Standing constraints

- **A desktop blueprint should declare `apps.runtime`.** It is what turns the
  Apps step on and picks which catalog the guest is offered (`winget` for
  Windows, `flatpak` for Linux). Validate warns on a desktop without one, and
  errors when the runtime contradicts the guest the strategy implies — a
  Windows blueprint declaring flatpak would offer a picker whose every pick
  fails in the guest.
- **App documents carry no URL and no digest, deliberately.** The package
  manager owns fetching and verifying; a copy of that claim here would only be
  a staler one. What rots instead is the identifier, which is why
  `check-sources` resolves every id nightly.
- **`MIN_SHA512_TRUENAS_VERSION` in `contract.ts` is empty on purpose.** It
  would gate sha512-only blueprints away from backends that predate digest
  support, but digest support shipped in the same change as blueprint sync
  itself, so no such backend exists. It is not a forgotten TODO.
- **Ignition guests deliver their config by config drive, never `fw_cfg`.**
  `fw_cfg` works, but the document rides in the domain's command line, where a
  phone-home token is visible in `ps` and survives every reboot because
  `command_line_args` is persisted and re-rendered. A config drive can be
  ejected and scrubbed once the install is confirmed. `contract.ts` pins each
  machine-config template to its required delivery for this reason — a mismatch
  fails silently, with the guest booting unconfigured.
- **This repo is public: never attach a self-hosted runner to a
  `pull_request` trigger.** An install-test harness has to run on real HexOS
  hardware, and a fork's PR would execute its own workflow file on that NAS.
  `workflow_dispatch` or a `pull_request_target`-free scheduled job only.

## Style

Match the surrounding file. Blueprints are 4-space JSON. Comments in `_lib/`
explain *why*, not what — several encode non-obvious constraints (silent
failure modes, sync behaviour) that are easy to undo by accident.
