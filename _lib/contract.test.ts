import { describe, expect, test } from "bun:test";
import { checkContract, declaredScripts } from "./contract";
import { parseVMHooks } from "./vm-surfaces";
import type { VMBlueprint } from "./vm-blueprint.schema";

// What the validator does with a blueprint's surface declarations: which scripts
// it must find, which of them withhold the whole blueprint when missing (a
// required setup hook) and which only drop their declaration, and that a
// parser error is a contract error.

const base = {
  id: "haos",
  name: "Home Assistant OS",
  description: "x",
  screenshots: [],
  category: "appliance",
  provisioning: {
    strategy: "image",
    source: { url: "https://example.test/haos_ova-{version}.qcow2.xz", version: "1", format: "qcow2", compression: "xz", sha256: "a".repeat(64), releasesUrl: "https://example.test/" },
  },
  resources: { minMemoryMb: 2048, recMemoryMb: 4096, minVcpus: 1, recVcpus: 2, diskGb: 32 },
  guest: { firmware: "UEFI", diskBus: "VIRTIO", nicModel: "VIRTIO", tpm: false, secureBoot: false, hypervEnlightenments: false, passthrough: [], readiness: { type: "mdns", hostname: "homeassistant.local", port: 8123 }, postInstallUrl: "http://{ip}:8123" },
} as unknown as VMBlueprint;

const hook = (overrides: Record<string, unknown> = {}) => ({
  id: "onboarding",
  title: "Onboarding check",
  events: ["onAfterReady"],
  script: "home-assistant-os/haos_setup.ts",
  entrypoint: "run",
  guestPort: 8123,
  ...overrides,
});

describe("declaredScripts", () => {
  test("names each hook's script with whether the sync would withhold the blueprint for it", () => {
    const bp = { ...base, hooksSchema: 1, hooks: [hook(), hook({ id: "optional", optional: true, script: "home-assistant-os/other.ts" })] } as VMBlueprint;
    expect(declaredScripts(bp)).toEqual([
      { kind: "hook", id: "onboarding", script: "home-assistant-os/haos_setup.ts", required: true },
      { kind: "hook", id: "optional", script: "home-assistant-os/other.ts", required: false },
    ]);
  });

  test("a blueprint without surfaces declares no scripts", () => {
    expect(declaredScripts(base)).toEqual([]);
  });

  test("a script path is any relative .ts or .js file in the repo (the blueprint's folder by convention); an absolute path or one that climbs is refused", () => {
    const parse = (script: string) => parseVMHooks({ hooks: [hook({ script })], guest: base.guest }, { form: "authoring" });
    expect(parse("shared/media.ts").hooks).toHaveLength(1);
    expect(parse("home-assistant-os/haos_setup.ts").hooks).toHaveLength(1);
    expect(parse("../secrets.ts").errors.join()).toContain('"." or ".." segments');
    expect(parse("/etc/haos.ts").errors.join()).toContain("relative to the catalog root");
  });
});

describe("checkContract on surface declarations", () => {
  test("a parser error is a contract error", () => {
    const bp = { ...base, hooksSchema: 1, hooks: [hook({ userOptional: { default: true }, kind: "connect" })] } as VMBlueprint;
    const { errors } = checkContract(bp, "home-assistant-os.json");
    expect(errors.some((error) => error.startsWith("hooks: ") && error.includes("default: false"))).toBe(true);
  });

  test("a well-formed declaration adds no error", () => {
    const bp = { ...base, hooksSchema: 1, hooks: [hook({ optional: true, userOptional: {} })] } as VMBlueprint;
    expect(checkContract(bp, "home-assistant-os.json").errors.filter((error) => error.startsWith("hooks: "))).toEqual([]);
  });
});

describe("a profile's own capability", () => {
  const MEDIA = ["Media", "Movies", "Shows", "Music", "Photos", "Videos"];
  const plexWith = (firstBoot: Record<string, unknown>, requiredCapabilities: string[]) =>
    ({
      ...base,
      requiredCapabilities,
      provisioning: { ...base.provisioning, strategy: "image", firstBoot: { profile: "plex-appliance", ...firstBoot } },
    }) as unknown as VMBlueprint;
  const ALL = ["firstBoot", "plexAppliance", "firstBootShareAccount"];

  test("shares on a profile that mounts none are refused, whatever the blueprint declares", () => {
    const openwrt = {
      ...base,
      requiredCapabilities: ["firstBoot", "firstBootShareAccount"],
      provisioning: {
        ...base.provisioning,
        strategy: "image",
        firstBoot: { profile: "openwrt-lan-dhcp", shares: ["Downloads"], shareAccount: "routervm" },
      },
    } as unknown as VMBlueprint;
    expect(checkContract(openwrt, "openwrt.json").errors.some((e) => e.includes("mounts shares"))).toBe(true);
  });

  test("the mediaShare flag is superseded by the list", () => {
    const flagged = plexWith({ mediaShare: true, shareAccount: "plexvm" }, ALL);
    expect(checkContract(flagged, "plex-server.json").errors.some((e) => e.includes("superseded"))).toBe(true);
  });

  test("a first boot that mounts shares must name its share account", () => {
    const unnamed = plexWith({ shares: MEDIA }, ALL);
    expect(checkContract(unnamed, "plex-server.json").errors.some((e) => e.includes("needs firstBoot.shareAccount"))).toBe(true);
    const named = plexWith({ shares: MEDIA, shareAccount: "plexvm" }, ALL);
    expect(checkContract(named, "plex-server.json").errors).toEqual([]);
  });

  test("shareAccess needs a share list, and write passes with one", () => {
    const listless = plexWith({ shareAccount: "plexvm", shareAccess: "write" }, ALL);
    expect(checkContract(listless, "plex-server.json").errors.some((e) => e.includes("firstBoot.shareAccess"))).toBe(true);
    const writer = plexWith({ shares: ["Downloads"], shareAccount: "plexvm", shareAccess: "write" }, ALL);
    expect(checkContract(writer, "plex-server.json").errors).toEqual([]);
  });

  test("the Plex profile must declare plexAppliance, and a shares first boot must declare firstBootShareAccount", () => {
    const bare = plexWith({ shares: MEDIA, shareAccount: "plexvm" }, ["firstBoot"]);
    const { errors } = checkContract(bare, "plex-server.json");
    expect(errors.some((e) => e.includes('declare "plexAppliance"'))).toBe(true);
    expect(errors.some((e) => e.includes('declare "firstBootShareAccount"') && e.includes("credential pair"))).toBe(true);
    // A box with only the older media capability would offer it and refuse every install.
    const pairOnly = plexWith({ shares: MEDIA, shareAccount: "plexvm" }, ["firstBoot", "plexAppliance", "firstBootDefaultMedia"]);
    expect(checkContract(pairOnly, "plex-server.json").errors.filter((e) => e.includes("needs requiredCapabilities"))).toHaveLength(1);
    // The capability the box reports at runtime while its setup-hooks gate is open is declarable; the unimplemented user-hooks one is not.
    const gated = plexWith({ shares: MEDIA, shareAccount: "plexvm" }, [...ALL, "vmHooks"]);
    expect(checkContract(gated, "plex-server.json").errors).toEqual([]);
    const unknown = plexWith({ shares: MEDIA, shareAccount: "plexvm" }, [...ALL, "vmUserHooks"]);
    expect(checkContract(unknown, "plex-server.json").errors.some((e) => e.includes("vmUserHooks"))).toBe(true);
  });
});
