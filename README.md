# hexos-vm-catalog

Curated VM blueprints for one-click virtual machine deployment on [HexOS](https://hexos.com).

A blueprint is a JSON document describing a ready-to-run VM: where to get its disk image (or how to answer its installer), the resource envelope to scale within, the virtual hardware it needs, and how HexOS knows it's online. HexOS syncs this repo on a schedule (the `prod` branch feeds production; staging environments sync `staging`) and handles everything else — storage placement, image download and verification, device creation, boot, and readiness detection.

## Available Blueprints

| Blueprint | Description |
|-----------|-------------|
| [Debian 13 (Trixie)](debian-13.json) | Official Debian cloud image, configured on first boot |
| [Fedora 44](fedora-44.json) | Official Fedora Cloud Base image, configured on first boot |
| [Fedora Workstation 44](fedora-workstation-44.json) | GNOME desktop, installed hands-free by Fedora's network installer |
| [Home Assistant OS](home-assistant-os.json) | Official Home Assistant appliance OS |
| [Rocky Linux 9](rocky-9.json) | Official Rocky GenericCloud image, RHEL-compatible |
| [Rocky Linux 10](rocky-10.json) | Official Rocky GenericCloud image; needs an x86-64-v3 CPU |
| [Ubuntu Desktop 26.04 LTS](ubuntu-desktop-26.04.json) | The Ubuntu desktop, installed hands-free from Canonical's official installer |
| [Ubuntu Server 24.04 LTS](ubuntu-24.04.json) | Canonical's official cloud image, configured on first boot |
| [Ubuntu Server 26.04 LTS](ubuntu-26.04.json) | Canonical's official cloud image, configured on first boot |
| [Windows 10 Pro](windows-10.json) | Unattended install from a user-supplied installer ISO |
| [Windows 11 Pro](windows-11.json) | Unattended install from a user-supplied installer ISO |

## Blueprint format

> [!WARNING]
> The blueprint format is still in flux and may change without notice, including in backwards-incompatible ways. The example below reflects the format at time of writing; always check the authoritative schema (see below) before writing or updating a blueprint.

```jsonc
{
    "id": "haos",                          // unique, lowercase, stable forever
    "name": "Home Assistant OS",
    "description": "…",
    "icon": "vms/haos",
    "category": "appliance",               // "server" | "desktop" | "appliance" (CI-enforced; the UI groups by this)
    "truenasVersion": ">=25.04.2.6",       // hidden on servers outside this range
    "cpuFeatures": ["avx2", "fma"],        // optional: /proc/cpuinfo flags the host CPU must have
                                           // (case-insensitive; hidden on hosts missing any — e.g.
                                           // list the x86-64-v3 flags for distros with that baseline)
    "internal": false,                     // true = never served from the prod branch
    "provisioning": {
        "strategy": "image",               // "image" | "cloud-init" | "answer-file" | "installer-iso"
        "source": {
            "url": "https://…/{version}/disk-{version}.qcow2.xz",  // {version} is substituted
            "version": "18.1",
            "format": "qcow2",             // "raw" | "qcow2"
            "compression": "xz",           // "none" | "xz" | "gz" | "zstd"
            "sha256": "…"                  // of the file as downloaded; required
        }
    },
    "resources": {
        "minMemoryMb": 2048, "recMemoryMb": 4096,
        "minVcpus": 1, "recVcpus": 2,
        "diskGb": 32
    },
    "guest": {
        "firmware": "UEFI",
        "diskBus": "VIRTIO",               // "AHCI" | "VIRTIO"
        "nicModel": "VIRTIO",              // "E1000" | "VIRTIO"
        "tpm": false, "secureBoot": false, "hypervEnlightenments": false,
        "readiness": { "type": "mdns", "hostname": "homeassistant.local", "port": 8123 },
        "postInstallUrl": "http://{ip}:8123"
    }
}
```

Strategy notes:

- **image** — a bootable appliance image streamed directly onto the VM disk (HAOS-style).
- **cloud-init** — a distro cloud image plus a `cloudInit.userDataTemplate` naming a first-boot template shipped in the HexOS backend. Readiness is usually `{ "type": "phone-home" }`.
- **answer-file** — installer automation (Windows). `source` is `{ "type": "user-iso" }` (the user supplies the installer ISO), `answerFile.template` names a backend template, and `extraMedia` lists additional ISOs (e.g. VirtIO drivers) attached as CD-ROMs.
- **installer-iso** — installer automation for freely redistributable media (desktop Linux). `source` is a downloadable ISO (`url`/`version`/`sha256`, no `format`/`compression`), and `seed.template` names a backend template that generates the answer-seed ISO attached alongside it (Ubuntu autoinstall on a NoCloud `cidata` volume, Fedora kickstart on `OEMDRV`). The VM disk starts blank; the installer fills it. Readiness is usually `{ "type": "phone-home" }`.

Version bumps are a two-field change: `source.version` and `source.sha256`.

The authoritative schema is `vmBlueprintSchema` in `hexos-platform/packages/shared/eshtek/vm-blueprints.ts` — documents failing it are rejected at sync time. A verbatim copy is vendored here at [`_lib/vm-blueprint.schema.ts`](_lib/vm-blueprint.schema.ts) so blueprints can be validated locally and in CI without the private platform package; the server remains the real gate.

## Validating locally

CI runs on every PR ([`.github/workflows/validate.yml`](.github/workflows/validate.yml)), but you can check your blueprint before pushing. Requires [Bun](https://bun.sh). All tooling lives under [`_lib/`](_lib/) — the catalog sync ingests every non-underscore `*.json` in the repo root, so anything that isn't a blueprint (this tooling, its `package.json`) is kept out of the root.

```bash
cd _lib
bun install
bun run validate
```

The validator checks each root `*.json` against the vendored schema, then applies a few contract checks the schema can't express ([`_lib/contract.ts`](_lib/contract.ts)):

- `cloudInit.userDataTemplate` / `answerFile.template` / `seed.template` must name a template the backend actually ships (`linux-default`, `win11-pro`, `win10-pro`, `ubuntu-desktop-autoinstall`, `fedora-workstation-kickstart` today) — this is the highest-value check; a typo passes schema validation and only fails at install time
- a duplicate `id` across two files is an error (the sync skips the duplicate)
- warnings for an `id` that differs from its filename stem, an off-convention `icon`, a `truenasVersion` with no comparison operator (a no-op gate), an unrecognized `cpuFeatures` flag name (a typo would hide the blueprint on every host), or `extraMedia` with no `sha256`

Errors fail the run; warnings don't.

### Keeping the schema copy current

The vendored schema is a copy, so it can drift as the platform schema evolves. Re-vendor from a local platform checkout (defaults to a `../hexos-platform` sibling; override with `HEXOS_PLATFORM`):

```bash
cd _lib
bun run sync-schema
```

When the backend adds a new provisioning template, also update the allowlists in [`_lib/contract.ts`](_lib/contract.ts).

## Contributing

1. Fork this repository
2. Add your blueprint JSON in the root directory (filename should match the `id`)
3. Run `bun run validate` and fix any errors
4. Test it against a staging/dev HexOS environment (sync from your branch, or point `VM_CATALOG_PATH` at your checkout)
5. Submit a pull request including where the image is published, how its checksum was obtained, and any special guest requirements
