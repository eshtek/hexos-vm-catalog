#!/usr/bin/env bash
# Re-vendor the catalog schemas from the hexOS platform monorepo into _lib/.
# Resolves paths from its own location; point HEXOS_PLATFORM at your platform
# checkout if it isn't the default sibling dir.
#
#   bun run sync-schema
#   HEXOS_PLATFORM=~/code/hexos-platform bun run sync-schema
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
catalog_root="$(cd "$here/.." && pwd)"
platform="${HEXOS_PLATFORM:-$catalog_root/../hexos-platform}"

# One entry per vendored schema: "<path under packages/shared/eshtek>:<dest under _lib>".
# Both documents this repo publishes (blueprints, apps) are validated locally
# against the platform's own schema, so both are vendored the same way.
schemas=(
  "vm-blueprints.ts:vm-blueprint.schema.ts"
  "vm-apps.ts:vm-app.schema.ts"
  "vm-blueprint-tests.ts:vm-blueprint-tests.schema.ts"
)

for entry in "${schemas[@]}"; do
  src="$platform/packages/shared/eshtek/${entry%%:*}"
  dest="$here/${entry##*:}"

  if [[ ! -f "$src" ]]; then
    echo "error: schema source not found at:" >&2
    echo "  $src" >&2
    echo "set HEXOS_PLATFORM to your hexos-platform checkout, e.g.:" >&2
    echo "  HEXOS_PLATFORM=~/code/hexos-platform bun run sync-schema" >&2
    exit 1
  fi

  {
    cat <<BANNER
// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of a schema from the hexOS platform monorepo:
//   packages/shared/eshtek/${entry%%:*}
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
// catalog sync in hexos-platform re-validates every document with the real
// schema at read time, so the server is always the authoritative gate.
// ─────────────────────────────────────────────────────────────────────────────

BANNER
    cat "$src"
  } >"$dest"

  # The vendored copy has to stand alone: this repo is public and has none of the
  # platform's other modules, so any import beyond zod resolves to nothing and
  # breaks `bun run validate` (and CI) the moment it lands. Caught here rather
  # than in a confused PR — upstream helpers needing other types belong in a
  # sibling file (see eshtek/vm-blueprint-guest.ts), not in the schema.
  stray_imports="$(grep -nE "^import .*from '(\.|\.\.)/" "$dest" || true)"
  if [[ -n "$stray_imports" ]]; then
    echo "" >&2
    echo "error: the vendored schema imports platform-local modules that do not exist here:" >&2
    echo "$stray_imports" >&2
    echo "" >&2
    echo "Move the offending code out of packages/shared/eshtek/${entry%%:*} (zod only)," >&2
    echo "then re-run this script." >&2
    exit 1
  fi

  echo "vendored: $src"
  echo "      ->  $dest"
done

echo "review the diff, then re-run: bun run validate"
