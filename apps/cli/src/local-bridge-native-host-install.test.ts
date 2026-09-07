import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_NATIVE_HOST_REGISTRY_KEYS,
  createLocalBridgeNativeHostArtifacts,
  installLocalBridgeNativeHost,
} from "./local-bridge-native-host-install";

function fixturePath(windowsPath: string): string {
  return process.platform === "win32" ? windowsPath : `/${windowsPath.replaceAll("\\", "/")}`;
}

const ROOT = fixturePath("C:\\MeanThisFixture\\LocalAppData");
const NODE = fixturePath("C:\\Program Files\\nodejs\\node.exe");
const ENTRY = fixturePath("D:\\MeanThis\\dist\\index.js");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("local bridge native host installation", () => {
  test("creates a content-addressed launcher and pinned Chrome manifest", () => {
    const artifacts = createLocalBridgeNativeHostArtifacts({
      localAppData: ROOT,
      nodePath: NODE,
      entryPath: ENTRY,
    });

    expect(artifacts.directory).toMatch(new RegExp(
      `^${escapeRegExp(join(ROOT, "MeanThis", "NativeMessaging"))}[\\\\/]` +
      `[a-f0-9]{64}$`,
    ));
    expect(artifacts.launcherBytes.toString("utf8")).toContain(
      `"${NODE}" "${ENTRY}" native-host %*`,
    );
    expect(artifacts.launcherBytes.toString("utf8")).toContain('set "MEANTHIS_MCP_HTTP_TOKEN="');
    expect(artifacts.launcherBytes.toString("utf8")).toContain('set "NODE_OPTIONS="');
    expect(artifacts.launcherBytes.toString("utf8")).toContain('set "NODE_PATH="');
    expect(JSON.parse(artifacts.manifestBytes.toString("utf8"))).toEqual({
      name: "app.meanthis.bridge",
      description: "MeanThis local bridge starter",
      path: join(artifacts.directory, "meanthis-native-host.cmd"),
      type: "stdio",
      allowed_origins: ["chrome-extension://bbiiccaidhlhdagmabkogleldjdnmlfn/"],
    });
  });

  test("writes exact artifacts before registering Chrome and Edge for the current user", async () => {
    const files = new Map<string, Buffer>();
    const registry = new Map<string, string>();
    const writeExactFile = vi.fn(async (path: string, bytes: Buffer) => {
      files.set(path, bytes);
    });
    const writeRegistryValue = vi.fn(async (key: string, value: string) => {
      expect(files.has(value)).toBe(true);
      registry.set(key, value);
    });

    const result = await installLocalBridgeNativeHost({
      platform: "win32",
      localAppData: ROOT,
      nodePath: NODE,
      entryPath: ENTRY,
      pathExists: async () => true,
      ensureDirectory: async () => undefined,
      writeExactFile,
      readRegistryValue: async (key) => registry.get(key) ?? null,
      writeRegistryValue,
      readExactFile: async (path) => files.get(path) ?? Buffer.alloc(0),
    });

    expect(result).toEqual({ status: "installed", browsers: ["chrome", "edge"] });
    expect(writeExactFile).toHaveBeenCalledTimes(2);
    expect(writeRegistryValue.mock.calls.map(([key]) => key)).toEqual(
      MEANTHIS_NATIVE_HOST_REGISTRY_KEYS.map(({ key }) => key),
    );
  });

  test("rechecks exact artifacts after registration and rejects drift", async () => {
    const artifacts = createLocalBridgeNativeHostArtifacts({
      localAppData: ROOT,
      nodePath: NODE,
      entryPath: ENTRY,
    });
    const files = new Map<string, Buffer>();
    const registry = new Map<string, string>();
    let finalRead = false;

    await expect(installLocalBridgeNativeHost({
      platform: "win32",
      localAppData: ROOT,
      nodePath: NODE,
      entryPath: ENTRY,
      pathExists: async () => true,
      ensureDirectory: async () => undefined,
      writeExactFile: async (path, bytes) => {
        files.set(path, bytes);
      },
      readRegistryValue: async (key) => {
        const value = registry.get(key) ?? null;
        if (registry.size === MEANTHIS_NATIVE_HOST_REGISTRY_KEYS.length) finalRead = true;
        return value;
      },
      writeRegistryValue: async (key, value) => {
        registry.set(key, value);
      },
      readExactFile: async (path) => finalRead && path === artifacts.launcherPath
        ? Buffer.from("drifted launcher")
        : files.get(path) ?? Buffer.alloc(0),
    })).rejects.toMatchObject({ code: "INSTALL_FAILED" });
  });

  test("fails closed on a foreign existing registration", async () => {
    const writeRegistryValue = vi.fn();
    await expect(installLocalBridgeNativeHost({
      platform: "win32",
      localAppData: ROOT,
      nodePath: NODE,
      entryPath: ENTRY,
      pathExists: async () => true,
      ensureDirectory: async () => undefined,
      writeExactFile: async () => undefined,
      readRegistryValue: async () => "C:\\Foreign\\host.json",
      writeRegistryValue,
    })).rejects.toMatchObject({ name: "LocalBridgeNativeHostInstallError", code: "REGISTRATION_DRIFT" });
    expect(writeRegistryValue).not.toHaveBeenCalled();
  });
});
