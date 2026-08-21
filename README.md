# hexos-vm-catalog

Curated VM blueprints for one-click virtual machine deployment on [HexOS](https://hexos.com).

A blueprint is a JSON document describing a ready-to-run VM: where to get its disk image (or how to answer its installer), the resource envelope to scale within, the virtual hardware it needs, and how HexOS knows it's online. HexOS syncs this repo on a schedule (the `prod` branch feeds production; staging environments sync `staging`) and handles everything else — storage placement, image download and verification, device creation, boot, and readiness detection.

## Available Blueprints

Grouped by `category`, which is how the HexOS UI groups them too.

### Server

| Blueprint | Description |
|-----------|-------------|
| [AlmaLinux 9](almalinux-9.json) | Official AlmaLinux GenericCloud image, RHEL-compatible |
| [AlmaLinux 10](almalinux-10.json) | Official AlmaLinux GenericCloud image; needs an x86-64-v3 CPU |
| [Debian 12 (Bookworm)](debian-12.json) | Official Debian cloud image, for workloads pinned to oldstable |
| [Debian 13 (Trixie)](debian-13.json) | Official Debian cloud image, configured on first boot |
| [Fedora 44](fedora-44.json) | Official Fedora Cloud Base image, configured on first boot |
| [Fedora CoreOS](fedora-coreos.json) | Minimal auto-updating container host, configured by Ignition |
| [Flatcar Container Linux](flatcar.json) | Immutable auto-updating container host, configured by Ignition |
| [Rocky Linux 9](rocky-9.json) | Official Rocky GenericCloud image, RHEL-compatible |
| [Rocky Linux 10](rocky-10.json) | Official Rocky GenericCloud image; needs an x86-64-v3 CPU |
| [Ubuntu Server 24.04 LTS](ubuntu-24.04.json) | Canonical's official cloud image, configured on first boot |
| [Ubuntu Server 26.04 LTS](ubuntu-26.04.json) | Canonical's official cloud image, configured on first boot |

### Desktop

| Blueprint | Description |
|-----------|-------------|
| [Bazzite](bazzite.json) | Gaming-focused atomic KDE desktop from Universal Blue; offers GPU passthrough |
| [CachyOS](cachyos.json) | Performance-tuned Arch with KDE Plasma, installed hands-free by its own headless installer |
| [Fedora KDE Plasma Desktop 44](fedora-kde-44.json) | KDE Plasma, from the same Fedora network installer as Workstation |
| [Fedora Workstation 44](fedora-workstation-44.json) | GNOME desktop, installed hands-free by Fedora's network installer |
| [Kubuntu 26.04 LTS](kubuntu-26.04.json) | Ubuntu with the KDE Plasma desktop, installed hands-free from the official ISO |
| [Linux Mint 22.3 Cinnamon](mint-22.3.json) | Cinnamon desktop, installed hands-free from the official ISO |
| [openSUSE Leap 16.0](opensuse-leap-16.json) | Fixed-release SLE-based desktop, installed hands-free by Agama |
| [Omarchy 4](omarchy.json) | DHH's Arch + Hyprland desktop, installed hands-free via the ISO's own autoinstall |
| [Pop!_OS 24.04 LTS](pop-os-24.04.json) | System76's COSMIC desktop, installed hands-free from the official ISO |
| [Ubuntu Desktop 26.04 LTS](ubuntu-desktop-26.04.json) | The Ubuntu desktop, installed hands-free from Canonical's official installer |
| [Windows 10 Pro](windows-10.json) | Unattended install from a user-supplied installer ISO |
| [Windows 11 Pro](windows-11.json) | Unattended install from a user-supplied installer ISO |
| [Xubuntu 26.04 LTS](xubuntu-26.04.json) | Ubuntu with the Xfce desktop, light on resources |
| [Zorin OS 18.1 Core](zorin-os-18.json) | Windows-familiar desktop, installed hands-free from the official ISO |

### Appliance

| Blueprint | Description |
|-----------|-------------|
| [Home Assistant OS](home-assistant-os.json) | Official Home Assistant appliance OS |
| [OpenWrt 25.12](openwrt.json) | Official OpenWrt x86-64 router/firewall image, managed from LuCI |

Drafts that aren't ready to ship live in a gitignored `_pending/` directory on
the maintainer's machine — a draft carries `TODO` digests and URLs nobody has
confirmed yet, and neither the sync nor the validator looks at underscore-
prefixed paths. Nothing is published from this repo until it reaches the root
with a real digest.

## Blueprint format

> [!WARNING]
> The blueprint format is still in flux and may change without notice, including in backwards-incompatible ways. The example below reflects the format at time of writing; always check the authoritative schema (see below) before writing or updating a blueprint.

```jsonc
{
    "id": "haos",                          // unique, lowercase, stable forever
    "name": "Home Assistant OS",
    "description": "…",
    "icon": "_icons/haos.svg",             // mirrored IN THIS REPO like screenshots; legacy
                                           // "vms/<slug>" keys still resolve against artwork
                                           // bundled with the frontend, but can't ship new art
    "website": "https://www.home-assistant.io/",  // product page; the detail sheet's "Website" button.
                                           // Distinct from source.releasesUrl (which nothing renders)
    "screenshots": [                       // mirrored IN THIS REPO, repo-relative; the detail sheet
        "haos/screenshots/dashboard.jpg",  // gallery shows the first 5. See "Screenshots" below
        "haos/screenshots/settings.jpg"
    ],
    "category": "appliance",               // "server" | "desktop" | "appliance" (CI-enforced; the UI groups by this)
    "truenasVersion": ">=25.04.2.6",       // hidden on servers outside this range
    "cpuFeatures": ["avx2", "fma"],        // optional: /proc/cpuinfo flags the host CPU must have
                                           // (case-insensitive; hidden on hosts missing any — e.g.
                                           // list the x86-64-v3 flags for distros with that baseline)
    "internal": false,                     // true = never served from the prod branch
    "provisioning": {
        "strategy": "image",               // "image" | "cloud-init" | "answer-file" | "installer-iso"
                                           //   | "installer-image" | "machine-config"
        "source": {
            "url": "https://…/{version}/disk-{version}.qcow2.xz",  // {version} is substituted
            "version": "18.1",
            "format": "qcow2",             // "raw" | "qcow2"
            "compression": "xz",           // "none" | "xz" | "gz" | "zstd" | "bz2"
            "sha256": "…",                 // of the file as downloaded, as published by the vendor
                                           // (use "sha512" instead where that is all they publish —
                                           // Debian's cloud images, for one; at least one is required)
            "releasesUrl": "https://…/"    // page listing this project's releases and their digests;
                                           // required, and what you open to bump the two fields above
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

### Provisioning strategies

`provisioning.strategy` picks one of six install pipelines. Each is described
here as what actually happens on the box, in the order the pipeline does it,
followed by what the blueprint has to supply. The steps mirror the roadmap the
install pipeline registers upfront, so this section is what needs re-checking
whenever the pipeline gains or loses a step.

#### `image` — boots the vendor image as shipped

1. Allocate the zvol at the requested disk size.
2. Download the vendor's disk image.
3. Verify it against the digest in the blueprint.
4. Decompress and write it to the zvol.
5. Configure the domain (firmware, disk bus, NIC, CPU, memory) and boot.
6. Wait for the guest to come online using the blueprint's readiness probe.

Nothing is injected — no account is collected because the appliance ships with
its own (HAOS-style). The blueprint supplies a bootable `source` image and a
`readiness` probe that can see the appliance's own UI (e.g. mDNS + port).

#### `cloud-init` — vendor image, configured on first boot

1. Allocate the zvol, download, verify and write the image (as for `image`).
2. Render the named user-data template with the first-user account (password
   hash and/or SSH key) plus a phone-home URL.
3. Attach the rendered document as a NoCloud seed volume.
4. Boot; cloud-init reads the seed on first boot and creates the account.
5. Wait for the guest to phone home. On success the seed stays attached — only
   a failed install removes it.

Needs a username and a password OR an SSH key — either login path is enough.
`cloudInit.userDataTemplate` names a first-boot template shipped in the HexOS
backend. Readiness is usually `{ "type": "phone-home" }`.

#### `machine-config` — container host configured by an Ignition/machine config

1. Allocate the zvol, download, verify and write the image (as for `image`).
2. Render the named machine-config template with the credentials and a
   phone-home URL.
3. Attach it as a config-drive volume the guest reads at first boot.
4. Boot; the guest applies the config to its built-in account.
5. Wait for the phone home, then eject and scrub the config drive.

Configures the image's built-in account (e.g. `core`) rather than creating one,
so no username is asked for — these guests ship no cloud-init at all (Fedora
CoreOS and Flatcar use Ignition). `source` is a prebuilt image, and
`machineConfig.template` names a backend template whose rendered document
reaches the guest via `machineConfig.delivery`. Always `config-drive`: `fw-cfg`
works, but the document rides in the domain's command line where it can't be
scrubbed after install.

#### `installer-iso` — runs the distro installer unattended

1. Allocate a BLANK zvol — the installer fills it, nothing is written up front.
2. Download the installer ISO (skipped when it is already cached on the box).
3. Render the seed (autoinstall / kickstart / preseed) with the account and the
   disk layout, and build it into a seed ISO.
4. Attach the installer ISO and the seed ISO as CD-ROMs, then boot.
5. The installer runs unattended and installs onto the zvol.
6. Wait for the INSTALLED system to phone home — that is what proves it
   rebooted out of the installer.
7. Eject and truncate the seed (it carries the password hash); eject the
   installer but keep it as the shared cache for the next install.

For freely redistributable media (desktop Linux). A password is mandatory here:
a desktop login cannot run on an SSH key alone. `source` is a downloadable ISO
(`url`/`version`/digest, no `format`/`compression`), and `seed.template` names
a backend template that generates the answer-seed ISO (Ubuntu autoinstall on a
NoCloud `cidata` volume, Fedora kickstart on `OEMDRV`). Readiness is usually
`{ "type": "phone-home" }`.

#### `installer-image` — recovery/installer media shipped as a raw disk image

1. Allocate a BLANK zvol — the installer fills it, nothing is written up front.
2. Download the vendor's raw installer image, verify it against the digest, and
   decompress it onto a dedicated MEDIA zvol (sized from the decompression
   estimate; sparse, so over-sizing costs nothing).
3. Render the seed (the install script) with the account and build it into a
   seed ISO.
4. Attach the blank target as the first disk, the media zvol as the second
   (firmware falls through the blank disk and boots the media), the seed as a
   CD-ROM, then boot.
5. After the live session settles, type the bootstrap into a text VT: it mounts
   the seed by volume label and runs the install script, which drives the
   image's own repair/install tooling against the target disk and powers off.
6. On the power-off, detach the media disk and the seed CD, and start the VM
   again — first boot runs media-less from the target.
7. Wait for the INSTALLED system to phone home, then truncate the seed (it
   carries the password hash) and destroy the media zvol — regenerable media,
   destroyed only on a confirmed install; a timeout keeps it attached.

For vendors that publish no installer ISO and no cloud image — only a raw
recovery disk image that must boot from its own drive and image a second one
(SteamOS's Steam Deck recovery image is the only case today). The guest's
account is the image's fixed built-in user (`deck`), so no username is asked
for; a password is mandatory because the image ships that account with an
empty password. `source` is a downloadable raw image (`url`/`version`/
`format`/`compression`/digest) and `seed.template` names the backend template
that generates the install script and drives the flow. Readiness is
`{ "type": "phone-home" }`.

#### `answer-file` — Windows Setup, unattended

1. Allocate a blank zvol.
2. Take the user's own Windows ISO from Install Media, or download the URL they
   pasted — HexOS cannot redistribute Windows media.
3. Render `autounattend.xml` with the computer name and administrator account,
   and attach it as a CD-ROM.
4. Attach the VirtIO driver ISO alongside it when the guest uses a VirtIO disk
   or NIC.
5. Boot; Windows Setup runs unattended and installs onto the zvol.
6. Install Windows updates, unless the install opted out of them.
7. Wait for the first-logon command to phone home, then eject and scrub the
   answer file — it holds a recoverable password. The user's own ISO is left
   alone.

The only strategy that requires the user to bring their own media: `source` is
`{ "type": "user-iso" }`, `answerFile.template` names a backend template, and
`extraMedia` lists additional ISOs (e.g. VirtIO drivers) attached as CD-ROMs.
`isoHelpUrl` is the vendor link the install dialog shows the user; it is
separate from `releasesUrl` (which nothing renders) even when both point at the
same page.

Version bumps are a two-field change: `source.version` and its digest. `source.releasesUrl` is where you go to make it — the vendor page listing available releases and their published checksums, recorded once per blueprint so nobody has to rediscover it. See [Checking for new versions](#checking-for-new-versions).

> [!NOTE]
> **`sha256` pins the media, not always the outcome.** For a *net* installer the
> package payload is fetched from the vendor's CDN at install time, so the hash
> never covered what actually lands on disk. One blueprint goes a step further:
> **CachyOS** installs by upgrading `cachyos-cli-installer-new` from CachyOS's
> repo in the live session, because the installer bundled in the ISO is months
> stale and cannot install headlessly at all (it has no `--config` flag and
> never formats the root partition). That is a deliberate, accepted trade-off —
> its install behavior tracks a repo package rather than the pinned ISO. If a
> net-installer blueprint breaks after an upstream release with its hash
> unchanged, suspect the vendor's tooling, and verify against the **shipped**
> artifact rather than the vendor's docs — repeatedly this year, published media
> has lagged the documented automation it is supposed to provide.

### Screenshots

The detail sheet renders a gallery of up to **5** screenshots of the desktop (or web UI) the
blueprint actually installs, mirroring how the app catalog presents an app.

Images are **mirrored into this repo** and referenced with repo-relative paths. The platform's
catalog sync rewrites those paths at sync time — to
`https://raw.githubusercontent.com/eshtek/hexos-vm-catalog/<branch>/<path>` normally, and to
`/vm-catalog-assets/<path>` when a developer points `VM_CATALOG_PATH` at a local checkout. Absolute
`https://` URLs are accepted by the schema (that is the resolved form) but should not appear in a
catalog file: hotlinking a vendor's CDN means the gallery breaks the day they reorganize it.

Conventions:

- One directory per blueprint: `<blueprint-id>/screenshots/<name>.jpg`.
- Downscale to **1280px wide** and save as JPEG (~quality 82). Source PNGs run 1–2 MB each; the
  gallery renders them at thumbnail size and this repo is cloned by CI.
  `sips -Z 1280 -s format jpeg -s formatOptions 82 in.png --out out.jpg` does it with no extra tools.
- Record provenance for every image in [`ATTRIBUTION.md`](ATTRIBUTION.md) — source, author and
  licence. Screenshots of GPL software are typically GPL and require attribution.
- **Only mirror images we have the right to redistribute.** Screenshots we captured ourselves from
  the guest we ship are the cleanest source: no third-party licence, and they show exactly the
  version this blueprint installs. Vendor marketing images generally are not redistributable —
  Windows especially.

`bun run validate` fails on a screenshot path that does not exist in the repo, which is the only
place a typo is catchable: the sync just rewrites the path, and a bad one surfaces as a broken image
in the UI long after the fact.

The authoritative schema is `vmBlueprintSchema` in `hexos-platform/packages/shared/eshtek/vm-blueprints.ts` — documents failing it are rejected at sync time. A verbatim copy is vendored here at [`_lib/vm-blueprint.schema.ts`](_lib/vm-blueprint.schema.ts) so blueprints can be validated locally and in CI without the private platform package; the server remains the real gate.

## Validating locally

CI runs on every PR ([`.github/workflows/validate.yml`](.github/workflows/validate.yml)), but you can check your blueprint before pushing. Requires [Bun](https://bun.sh). All tooling lives under [`_lib/`](_lib/) — the catalog sync ingests every non-underscore `*.json` in the repo root, so anything that isn't a blueprint (this tooling, its `package.json`) is kept out of the root.

```bash
cd _lib
bun install
bun run validate
```

The validator checks each root `*.json` against the vendored schema, then applies a few contract checks the schema can't express ([`_lib/contract.ts`](_lib/contract.ts)):

- `cloudInit.userDataTemplate` / `answerFile.template` / `seed.template` must name a template the backend actually ships (`linux-default`, `win11-pro`, `win10-pro`, `ubuntu-desktop-autoinstall`, `fedora-workstation-kickstart`, `fedora-kde-kickstart`, `opensuse-agama-profile`, `bazzite-kickstart`, `mint-preseed`, `zorin-preseed`, `pop-live-exec`, `omarchy-autoinstall`, `cachyos-headless`, `steamos-repair`, plus the machine-config pair `fcos-ignition` / `flatcar-ignition` today) — this is the highest-value check; a typo passes schema validation and only fails at install time
- a duplicate `id` across two files is an error (the sync skips the duplicate)
- `source.releasesUrl` must be present — the schema leaves it optional for admin-authored rows, but a catalog blueprint that doesn't say where its next version comes from is how `-latest` URLs and guessed digests get in
- warnings for an `id` that differs from its filename stem, an off-convention `icon`, a `truenasVersion` with no comparison operator (a no-op gate), an unrecognized `cpuFeatures` flag name (a typo would hide the blueprint on every host), `extraMedia` with no `sha256`, or a `releasesUrl` pointing at a file rather than a listing

Errors fail the run; warnings don't.

### Keeping the schema copy current

The vendored schema is a copy, so it can drift as the platform schema evolves. Re-vendor from a local platform checkout (defaults to a `../hexos-platform` sibling; override with `HEXOS_PLATFORM`):

```bash
cd _lib
bun run sync-schema
```

When the backend adds a new provisioning template, also update the allowlists in [`_lib/contract.ts`](_lib/contract.ts).

## Checking for new versions

`releases.ts` prints every blueprint's pinned version alongside the page that would announce a newer one — the starting point for a bump pass:

```bash
cd _lib
bun run releases              # id, pinned version, digest algorithm, releases page
bun run releases -- --pending # include the _pending/ drafts
bun run releases -- --check   # confirm each page still resolves
bun run releases -- --json    # machine-readable
```

Nothing fetches `releasesUrl` at sync or install time and no client renders it, so `--check` reports and always exits 0 — unlike `bun run check-sources`, which HEADs the pinned artifacts nightly and fails when one 404s.

## Contributing

1. Fork this repository
2. Add your blueprint JSON in the root directory (filename should match the `id`)
3. Run `bun run validate` and fix any errors
4. Test it against a staging/dev HexOS environment (sync from your branch, or point `VM_CATALOG_PATH` at your checkout)
5. Submit a pull request including where the image is published, how its checksum was obtained, and any special guest requirements
