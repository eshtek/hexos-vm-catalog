#!/usr/bin/env bash
# Re-vendor the blueprint schema from the hexOS platform monorepo into
# _lib/vm-blueprint.schema.ts. Resolves paths from its own location; point
# HEXOS_PLATFORM at your platform checkout if it isn't the default sibling dir.
#
#   bun run sync-schema
#   HEXOS_PLATFORM=~/code/hexos-platform bun run sync-schema
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
catalog_root="$(cd "$here/.." && pwd)"
platform="${HEXOS_PLATFORM:-$catalog_root/../hexos-platform}"
src="$platform/packages/shared/eshtek/vm-blueprints.ts"
dest="$here/vm-blueprint.schema.ts"

if [[ ! -f "$src" ]]; then
  echo "error: schema source not found at:" >&2
  echo "  $src" >&2
  echo "set HEXOS_PLATFORM to your hexos-platform checkout, e.g.:" >&2
  echo "  HEXOS_PLATFORM=~/code/hexos-platform bun run sync-schema" >&2
  exit 1
fi

{
  cat <<'BANNER'
// ─────────────────────────────────────────────────────────────────────────────
// VENDORED FILE — do not edit by hand.
//
// Verbatim copy of the blueprint schema from the hexOS platform monorepo:
//   packages/shared/eshtek/vm-blueprints.ts
//
// That file is the single source of truth. This repo keeps a copy so blueprints
// can be validated locally and in CI without depending on the private platform
// package (see Q1 in the Zero-Touch VM Provisioning plan — "copy, don't share").
//
// Re-vendor after any upstream schema change:
//   bun run sync-schema        # wraps _lib/sync-schema.sh
//
// If this copy drifts from upstream it only produces false local results — the
// catalog sync in hexos-platform re-validates every blueprint with the real
// schema at read time, so the server is always the authoritative gate.
// ─────────────────────────────────────────────────────────────────────────────

BANNER
  cat "$src"
} >"$dest"

echo "vendored: $src"
echo "      ->  $dest"
echo "review the diff, then re-run: bun run validate"
