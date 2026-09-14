import { describe, expect, test } from "bun:test";
import { checkContract, declaredScripts } from "./contract";
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
  script: "_hooks/haos_setup.ts",
  entrypoint: "run",
  guestPort: 8123,
  ...overrides,
});

describe("declaredScripts", () => {
  test("names each hook's script with whether the sync would withhold the blueprint for it", () => {
    const bp = { ...base, hooksSchema: 1, hooks: [hook(), hook({ id: "optional", optional: true, script: "_hooks/other.ts" })] } as VMBlueprint;
    expect(declaredScripts(bp)).toEqual([
      { kind: "hook", id: "onboarding", script: "_hooks/haos_setup.ts", required: true },
      { kind: "hook", id: "optional", script: "_hooks/other.ts", required: false },
    ]);
  });

  test("a blueprint without surfaces declares no scripts", () => {
    expect(declaredScripts(base)).toEqual([]);
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
