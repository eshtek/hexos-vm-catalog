#!/usr/bin/env bash
# Print the official checksum for each blueprint under _pending/ that still has
# a "TODO" digest. Read-only on purpose: it prints, you paste. A checksum that
# lands in the catalog should have been looked at by a person.
#
#   cd _lib && ./fetch-checksums.sh
#
# Handles both SHA256SUMS-style manifests and openSUSE's per-file .sha512
# sidecars. Blueprints may carry sha256, sha512, or both — the install pipeline
# verifies every digest present.
#
# _pending/ is gitignored, so this script is committed but the directory it
# reads is not: on a fresh clone it reports no drafts, which is correct.

set -euo pipefail

PENDING="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_pending"

# blueprint-id | field | checksum-file URL | filename to grep for
# https only: a digest fetched over plaintext can be rewritten in transit by
# anyone who could also rewrite the image, which defeats the point of fetching
# it from the publisher at all.
SOURCES=(
    "opensuse-leap-16|sha512|https://download.opensuse.org/distribution/leap/16.0/offline/Leap-16.0-offline-installer-x86_64-Build178.27.install.iso.sha512|Leap-16.0-offline-installer-x86_64-Build178.27.install.iso"
)

# Expected hex length per field, so a truncated or wrong-algorithm fetch is
# caught here rather than at install time. A case rather than an associative
# array: macOS still ships bash 3.2, where `declare -A` is a syntax error and,
# under `set -u`, fails as an unbound variable long before the first fetch.
hexlen() {
    case "$1" in
        sha256) echo 64 ;;
        sha512) echo 128 ;;
        *) echo "unknown checksum field '$1'" >&2; return 1 ;;
    esac
}

echo "Drafts still carrying a TODO checksum:"
grep -lE '"sha(256|512)": "TODO"' "$PENDING"/*.json 2>/dev/null | xargs -r -n1 basename || echo "  (none)"
echo

for entry in "${SOURCES[@]}"; do
    IFS='|' read -r id field url iso <<< "$entry"
    printf '%s\n' "── $id"
    if ! body="$(curl -fsSL --max-time 30 "$url" 2>/dev/null)"; then
        echo "   could not fetch $url"
        continue
    fi
    # Manifest lines look like "<hex>  *<filename>"; openSUSE sidecars are a
    # single line for the one file. Match on the filename when it is present.
    if printf '%s\n' "$body" | grep -qF -- "$iso"; then
        line="$(printf '%s\n' "$body" | grep -F -- "$iso" | head -n1)"
        # Some CHECKSUM files use BSD form: SHA256 (file) = <hex>
        case "$line" in *') = '*) line="${line##*= }" ;; esac
    elif [ "$(printf '%s\n' "$body" | grep -cE '^[a-fA-F0-9]{64,128}')" = "1" ]; then
        # Single-digest sidecar (openSUSE): the one line IS this file's digest.
        line="$(printf '%s\n' "$body" | grep -oE '^[a-fA-F0-9]{64,128}' | head -n1)"
    else
        # A multi-file manifest that doesn't name the file we asked for means
        # the filename is wrong — usually a version that moved. Taking the
        # first hash in the file would confidently print SOME OTHER IMAGE'S
        # digest, which is worse than printing nothing. AlmaLinux 10 hit this:
        # the real name carries a trailing ".0" the entry here was missing.
        echo "   $iso is not listed in $url"
        echo "   the build was probably superseded — check the directory listing and update SOURCES"
        continue
    fi
    sum="$(printf '%s\n' "$line" | awk '{print $1}' | tr 'A-F' 'a-f')"
    want="$(hexlen "$field")"
    if [[ ! "$sum" =~ ^[a-f0-9]{$want}$ ]]; then
        echo "   no $field found for $iso — the build may have been superseded"
        echo "   check the directory listing and update SOURCES in this script"
        continue
    fi
    echo "   \"$field\": \"$sum\""
done

cat <<'NOTE'

Paste each line into the matching draft in _pending/, replacing the "TODO".
openSUSE also publishes a detached signature (.sha512.asc); verifying it with
gpgv against the openSUSE signing key is worth doing once by hand before
trusting the digest.
NOTE
