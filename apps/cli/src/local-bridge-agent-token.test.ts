import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getLocalBridgeAgentTokenPath,
  loadOrCreateLocalBridgeAgentToken,
} from "./local-bridge-agent-token";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local bridge agent token", () => {
  test("creates one profile-scoped token and reuses it", async () => {
    const codexHome = await createCodexHome();
    const first = await loadOrCreateLocalBridgeAgentToken({
      codexHome,
      randomBytes: (size) => Buffer.alloc(size, 11),
    });
    const second = await loadOrCreateLocalBridgeAgentToken({ codexHome });

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect(await readFile(getLocalBridgeAgentTokenPath(codexHome), "utf8"))
      .toBe(`${first}\n`);
  });

  test("fails closed without replacing a malformed existing credential", async () => {
    const codexHome = await createCodexHome();
    const path = getLocalBridgeAgentTokenPath(codexHome);
    await mkdir(join(codexHome, "ui-attach"));
    await writeFile(path, "not-a-valid-token\n", "utf8");

    await expect(loadOrCreateLocalBridgeAgentToken({ codexHome }))
      .rejects.toThrow("invalid");
    expect(await readFile(path, "utf8")).toBe("not-a-valid-token\n");
  });
});

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ui-attach-token-"));
  roots.push(root);
  return root;
}
