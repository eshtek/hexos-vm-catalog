# hexos-vm-catalog

Curated VM blueprints for one-click virtual machine deployment on [HexOS](https://hexos.com).

A blueprint is a JSON document describing a ready-to-run VM: where to get its disk image (or how to answer its installer), the resource envelope to scale within, the virtual hardware it needs, and how HexOS knows it's online. HexOS syncs this repo on a schedule (the `prod` branch feeds production; staging environments sync `staging`) and handles everything else — storage placement, image download and verification, device creation, boot, and readiness detection.

## Available Blueprints

| Blueprint | Description |
|-----------|-------------|
| [Home Assistant OS](home-assistant-os.json) | Official Home Assistant appliance OS |
| [Ubuntu Server 24.04 LTS](ubuntu-24.04.json) | Canonical's official cloud image, configured on first boot |
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
    "category": "smart-home",
    "truenasVersion": ">=25.04.2.6",       // hidden on servers outside this range
    "internal": false,                     // true = never served from the prod branch
    "provisioning": {
        "strategy": "image",               // "image" | "cloud-init" | "answer-file"
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

Version bumps are a two-field change: `source.version` and `source.sha256`.

The authoritative schema is `vmBlueprintSchema` in `hexos-platform/packages/shared/eshtek/vm-blueprints.ts` — documents failing it are rejected at sync time.

## Contributing

1. Fork this repository
2. Add your blueprint JSON in the root directory (filename should match the `id`)
3. Test it against a staging/dev HexOS environment (sync from your branch, or point `VM_CATALOG_PATH` at your checkout)
4. Submit a pull request including where the image is published, how its checksum was obtained, and any special guest requirements
