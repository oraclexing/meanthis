import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LOCAL_BRIDGE_AGENT_TOKEN_ROTATION_REQUIRED,
  LocalBridgeAgentTokenRotationCommittedButUnverifiedError,
  LocalBridgeAgentTokenRotationRequiredError,
  LocalBridgeAgentTokenUnavailableError,
  MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
  fingerprintLocalBridgeAgentToken,
  getLocalBridgeAgentTokenPath,
  inspectLocalBridgeAgentToken,
  loadOrCreateLocalBridgeAgentToken,
  readLocalBridgeAgentToken,
  readVerifiedLocalBridgeAgentToken,
  rotateLocalBridgeAgentToken,
} from "./local-bridge-agent-token";
import { applyLocalBridgeWindowsProtectedAcl } from "./local-bridge-mcp-http-token";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local bridge agent token", () => {
  test("reuses an existing protected credential without creating or repairing storage", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const token = Buffer.alloc(32, 2).toString("base64url");
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    await expect(readVerifiedLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    })).resolves.toBe(token);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).toHaveBeenCalledTimes(4);
  });

  test("does not create a missing credential while reading for owner startup", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);

    await expect(readVerifiedLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    })).rejects.toMatchObject({
      name: "LocalBridgeAgentTokenUnavailableError",
      code: "BRIDGE_AGENT_CREDENTIAL_UNAVAILABLE",
    });
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).not.toHaveBeenCalled();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reads an exact existing credential for a fast watcher without touching ACLs", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const token = Buffer.alloc(32, 3).toString("base64url");
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    await expect(readLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    })).resolves.toBe(token);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).not.toHaveBeenCalled();
  });

  test.each(["changed", "replaced"] as const)(
    "rejects a credential whose identity is %s during the bounded read",
    async (mutation) => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const path = getLocalBridgeAgentTokenPath(codexHome);
      const displacedPath = `${path}.displaced`;
      const token = Buffer.alloc(32, 4).toString("base64url");
      const nextToken = Buffer.alloc(32, 5).toString("base64url");
      await mkdir(directory);
      await writeFile(path, `${token}\n`, "utf8");

      await expect(readLocalBridgeAgentToken({
        codexHome,
        readCredentialFile: async (candidatePath) => {
          const raw = await readFile(candidatePath, "utf8");
          if (mutation === "changed") {
            // Make the identity change deterministic even on filesystems whose
            // sub-millisecond timestamp updates collapse under test load.
            await writeFile(candidatePath, `${nextToken}\n\n`, "utf8");
          } else {
            await rename(candidatePath, displacedPath);
            await writeFile(candidatePath, `${nextToken}\n`, "utf8");
          }
          return raw;
        },
      })).rejects.toBeInstanceOf(LocalBridgeAgentTokenUnavailableError);
    },
  );

  test.each([
    ["missing directory", async (codexHome: string) => undefined],
    ["missing file", async (codexHome: string) => mkdir(join(codexHome, "ui-attach"))],
    ["malformed", async (codexHome: string) => {
      const directory = join(codexHome, "ui-attach");
      await mkdir(directory);
      await writeFile(getLocalBridgeAgentTokenPath(codexHome), "malformed\n", "utf8");
    }],
    ["oversize", async (codexHome: string) => {
      const directory = join(codexHome, "ui-attach");
      await mkdir(directory);
      await writeFile(getLocalBridgeAgentTokenPath(codexHome), "x".repeat(46), "utf8");
    }],
    ["symbolic-link storage", async (codexHome: string) => {
      const target = join(codexHome, "linked-target");
      await mkdir(target);
      await symlink(target, join(codexHome, "ui-attach"), "junction");
    }],
  ] as const)("bounds %s as unavailable without creating or repairing", async (_label, setup) => {
    const codexHome = await createCodexHome();
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);
    await setup(codexHome);

    await expect(readLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    })).rejects.toMatchObject({
      name: "LocalBridgeAgentTokenUnavailableError",
      code: "BRIDGE_AGENT_CREDENTIAL_UNAVAILABLE",
      message: "Local bridge agent credential is unavailable.",
    });
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).not.toHaveBeenCalled();
  });

  test("does not leak a path or token when the fast watcher read fails", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const token = Buffer.alloc(32, 6).toString("base64url");
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    let thrown: unknown;
    try {
      await readLocalBridgeAgentToken({
        codexHome,
        readCredentialFile: async () => {
          throw new Error(`read failed: ${path} ${token}`);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LocalBridgeAgentTokenUnavailableError);
    const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
    expect(publicError).not.toContain(token);
    expect(publicError).not.toContain(path);
    expect(publicError).not.toContain(codexHome);
  });

  test("inspects a missing credential without creating or hardening storage", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);

    await expect(inspectLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    })).resolves.toEqual({
      kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
      status: "missing",
    });
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).not.toHaveBeenCalled();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports a secure credential with only a non-secret fingerprint", async () => {
    const codexHome = await createCodexHome();
    const token = await loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      inspectAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);

    const inspection = await inspectLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    });

    expect(inspection).toEqual({
      kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
      status: "ready",
      fingerprint: fingerprintLocalBridgeAgentToken(token),
    });
    expect(JSON.stringify(inspection)).not.toContain(token);
    expect(JSON.stringify(inspection)).not.toContain(codexHome);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).toHaveBeenCalled();
  });

  test("reports insecure ACL state without mutating or leaking the credential", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const token = Buffer.alloc(32, 8).toString("base64url");
    const applyAcl = vi.fn(async () => undefined);
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    const inspection = await inspectLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl: async () => {
        throw new Error(`unsafe ${path} ${token}`);
      },
    });

    expect(inspection).toEqual({
      kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
      status: "insecure",
    });
    expect(JSON.stringify(inspection)).not.toContain(token);
    expect(JSON.stringify(inspection)).not.toContain(path);
    expect(JSON.stringify(inspection)).not.toContain(codexHome);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(`${token}\n`);
  });

  test("classifies malformed files and symbolic-link storage as invalid", async () => {
    const malformedHome = await createCodexHome();
    const malformedDirectory = join(malformedHome, "ui-attach");
    await mkdir(malformedDirectory);
    await writeFile(
      getLocalBridgeAgentTokenPath(malformedHome),
      "not-a-valid-token\n",
      "utf8",
    );
    await expect(inspectLocalBridgeAgentToken({
      codexHome: malformedHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).resolves.toEqual({
      kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
      status: "invalid",
    });

    const linkedHome = await createCodexHome();
    const target = join(linkedHome, "linked-target");
    await mkdir(target);
    await symlink(target, join(linkedHome, "ui-attach"), "junction");
    await expect(inspectLocalBridgeAgentToken({ codexHome: linkedHome }))
      .resolves.toEqual({
        kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
        status: "invalid",
      });
  });

  test("bounds credential read failures as unavailable", async () => {
    const codexHome = await createCodexHome();
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const token = await loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      inspectAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 9),
    });
    const applyAcl = vi.fn(async () => undefined);

    const inspection = await inspectLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl: async () => undefined,
      readCredentialFile: async () => {
        throw new Error(`read failed: ${path} ${token}`);
      },
    });

    expect(inspection).toEqual({
      kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
      status: "unavailable",
    });
    expect(JSON.stringify(inspection)).not.toContain(token);
    expect(JSON.stringify(inspection)).not.toContain(path);
    expect(applyAcl).not.toHaveBeenCalled();
  });

  test("creates a protected profile token and reuses it through read-only verification", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);

    const first = await loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
      randomBytes: (size) => Buffer.alloc(size, 11),
    });
    expect(applyAcl).toHaveBeenCalledWith(directory, "directory");
    expect(applyAcl).toHaveBeenCalledWith(path, "file");
    expect(inspectAcl).toHaveBeenCalledWith(directory, "directory");
    expect(inspectAcl).toHaveBeenCalledWith(path, "file");

    applyAcl.mockClear();
    inspectAcl.mockClear();
    const second = await loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    });

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect(await readFile(path, "utf8")).toBe(`${first}\n`);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).toHaveBeenCalledWith(directory, "directory");
    expect(inspectAcl).toHaveBeenCalledWith(path, "file");
  });

  test("requires a canonical 32-byte base64url credential", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const canonical = Buffer.alloc(32, 17).toString("base64url");
    const nonCanonical = `${canonical.slice(0, -1)}_`;
    expect(nonCanonical).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(nonCanonical, "base64url").toString("base64url"))
      .not.toBe(nonCanonical);
    await mkdir(directory);
    await writeFile(path, `${nonCanonical}\n`, "utf8");

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).rejects.toThrow("invalid");
    expect(await readFile(path, "utf8")).toBe(`${nonCanonical}\n`);

    const freshHome = await createCodexHome();
    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome: freshHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      inspectAcl: async () => undefined,
      randomBytes: () => Buffer.alloc(31),
    })).rejects.toThrow("invalid");
  });

  test("fails closed without replacing a malformed existing credential", async () => {
    const codexHome = await createCodexHome();
    const path = getLocalBridgeAgentTokenPath(codexHome);
    await mkdir(join(codexHome, "ui-attach"));
    await writeFile(path, "not-a-valid-token\n", "utf8");

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).rejects.toThrow("invalid");
    expect(await readFile(path, "utf8")).toBe("not-a-valid-token\n");
  });

  test.each(["directory", "file"] as const)(
    "rejects an existing credential with an insecure %s ACL without repairing or reusing it",
    async (insecureKind) => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const path = getLocalBridgeAgentTokenPath(codexHome);
      const token = Buffer.alloc(32, 23).toString("base64url");
      const applyAcl = vi.fn(async () => undefined);
      await mkdir(directory);
      await writeFile(path, `${token}\n`, "utf8");

      let thrown: unknown;
      try {
        await loadOrCreateLocalBridgeAgentToken({
          codexHome,
          processPlatform: "win32",
          applyAcl,
          inspectAcl: async (candidatePath, kind) => {
            if (kind === insecureKind) {
              throw new Error(`unsafe ${kind}: ${candidatePath} ${token}`);
            }
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LocalBridgeAgentTokenRotationRequiredError);
      expect(thrown).toMatchObject({
        code: "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED",
        status: LOCAL_BRIDGE_AGENT_TOKEN_ROTATION_REQUIRED,
        rotationRequired: true,
        credentialReused: false,
        credentialMayHaveBeenExposed: true,
      });
      expect(applyAcl).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(`${token}\n`);
      const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
      expect(publicError).toContain("explicit rotation is required");
      expect(publicError).not.toContain(token);
      expect(publicError).not.toContain(path);
      expect(publicError).not.toContain(codexHome);
    },
  );

  test("removes a newly created empty directory when directory ACL hardening fails", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (_path, kind) => {
        if (kind === "directory") throw new Error("directory ACL failure with secret path");
      },
      inspectAcl: async () => undefined,
    })).rejects.toThrow("unavailable");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a pre-existing directory when directory ACL hardening fails", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    await mkdir(directory);

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (_path, kind) => {
        if (kind === "directory") throw new Error("directory ACL failure");
      },
      inspectAcl: async (_path, kind) => {
        if (kind === "directory") throw new Error("directory ACL is insecure");
      },
    })).rejects.toThrow("unavailable");
    expect((await lstat(directory)).isDirectory()).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  test.each(["apply", "readback"] as const)(
    "cleans up only its unchanged token and empty directory after file ACL %s failure",
    async (failureStage) => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const path = getLocalBridgeAgentTokenPath(codexHome);

      await expect(loadOrCreateLocalBridgeAgentToken({
        codexHome,
        processPlatform: "win32",
        applyAcl: async (_candidatePath, kind) => {
          if (kind === "file" && failureStage === "apply") {
            throw new Error(`file apply failed: ${path}`);
          }
        },
        inspectAcl: async (_candidatePath, kind) => {
          if (kind === "file" && failureStage === "readback") {
            throw new Error(`file readback failed: ${path}`);
          }
        },
        randomBytes: (size) => Buffer.alloc(size, 24),
      })).rejects.toThrow("unavailable");

      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("removes its failed token but preserves a pre-existing empty directory", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    await mkdir(directory);

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (_candidatePath, kind) => {
        if (kind === "file") throw new Error("file ACL failure");
      },
      inspectAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 25),
    })).rejects.toThrow("unavailable");

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(directory)).isDirectory()).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  test("does not delete a replacement file or a now non-empty directory after hardening fails", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const winner = Buffer.alloc(32, 26).toString("base64url");

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (candidatePath, kind) => {
        if (kind !== "file") return;
        await rm(candidatePath);
        await writeFile(candidatePath, `${winner}\n`, "utf8");
        await writeFile(join(directory, "concurrent-entry"), "keep", "utf8");
        throw new Error("hardening failed after replacement");
      },
      inspectAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 25),
    })).rejects.toThrow("unavailable");

    expect(await readFile(path, "utf8")).toBe(`${winner}\n`);
    expect(await readFile(join(directory, "concurrent-entry"), "utf8")).toBe("keep");
  });

  test("concurrent wx creators converge on one protected credential", async () => {
    const codexHome = await createCodexHome();
    const firstToken = Buffer.alloc(32, 31).toString("base64url");
    const secondToken = Buffer.alloc(32, 32).toString("base64url");
    const securePaths = new Set<string>();
    const applyAcl = vi.fn(async (path: string) => {
      securePaths.add(path);
    });
    const inspectAcl = vi.fn(async (path: string) => {
      if (!securePaths.has(path)) throw new Error("ACL not yet applied");
    });

    const [first, second] = await Promise.all([
      loadOrCreateLocalBridgeAgentToken({
        codexHome,
        processPlatform: "win32",
        applyAcl,
        inspectAcl,
        randomBytes: () => Buffer.from(firstToken, "base64url"),
      }),
      loadOrCreateLocalBridgeAgentToken({
        codexHome,
        processPlatform: "win32",
        applyAcl,
        inspectAcl,
        randomBytes: () => Buffer.from(secondToken, "base64url"),
      }),
    ]);

    expect(first).toBe(second);
    expect([firstToken, secondToken]).toContain(first);
    expect(await readFile(getLocalBridgeAgentTokenPath(codexHome), "utf8"))
      .toBe(`${first}\n`);
  });

  test("recovers an insecure existing credential only through explicit rotation", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const oldToken = Buffer.alloc(32, 41).toString("base64url");
    const nextToken = Buffer.alloc(32, 42).toString("base64url");
    await mkdir(directory);
    await writeFile(path, `${oldToken}\n`, "utf8");

    await expect(loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => { throw new Error("insecure"); },
    })).rejects.toBeInstanceOf(LocalBridgeAgentTokenRotationRequiredError);

    await expect(rotateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      inspectAcl: async () => undefined,
      randomBytes: () => Buffer.from(nextToken, "base64url"),
    })).resolves.toBe(nextToken);
    expect(await readFile(path, "utf8")).toBe(`${nextToken}\n`);
    expect(await loadOrCreateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).toBe(nextToken);
  });

  test("does not rewrite an already protected directory while rotating an insecure credential", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const oldToken = Buffer.alloc(32, 47).toString("base64url");
    const nextToken = Buffer.alloc(32, 48).toString("base64url");
    let fileSecured = false;
    const applyAcl = vi.fn(async (candidatePath: string) => {
      if (candidatePath === directory) {
        throw new Error("rewriting a protected directory requires unavailable privilege");
      }
      fileSecured = true;
    });
    const inspectAcl = vi.fn(async (candidatePath: string) => {
      if (candidatePath !== directory && !fileSecured) throw new Error("insecure");
    });
    await mkdir(directory);
    await writeFile(path, `${oldToken}\n`, "utf8");

    await expect(rotateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
      randomBytes: () => Buffer.from(nextToken, "base64url"),
    })).resolves.toBe(nextToken);

    expect(applyAcl).not.toHaveBeenCalledWith(directory, "directory");
    expect(inspectAcl).toHaveBeenCalledWith(directory, "directory");
    expect(await readFile(path, "utf8")).toBe(`${nextToken}\n`);
  });

  test.runIf(process.platform === "win32")(
    "rotates an inherited-ACL credential inside a real protected Windows profile directory",
    { tags: ["platform"], timeout: 20_000 },
    async () => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const path = getLocalBridgeAgentTokenPath(codexHome);
      const oldToken = Buffer.alloc(32, 49).toString("base64url");
      const nextToken = Buffer.alloc(32, 50).toString("base64url");
      await mkdir(directory);
      await applyLocalBridgeWindowsProtectedAcl(directory, "directory");
      await writeFile(path, `${oldToken}\n`, "utf8");

      await expect(inspectLocalBridgeAgentToken({ codexHome })).resolves.toMatchObject({
        status: "insecure",
      });
      await expect(rotateLocalBridgeAgentToken({
        codexHome,
        randomBytes: () => Buffer.from(nextToken, "base64url"),
      })).resolves.toBe(nextToken);
      await expect(inspectLocalBridgeAgentToken({ codexHome })).resolves.toMatchObject({
        status: "ready",
      });
    },
  );

  test("keeps the previous credential and removes its temporary file when rotation hardening fails", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const oldToken = Buffer.alloc(32, 43).toString("base64url");
    await mkdir(directory);
    await writeFile(path, `${oldToken}\n`, "utf8");

    await expect(rotateLocalBridgeAgentToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (candidatePath, kind) => {
        if (kind === "file") throw new Error(`hardening failed at ${candidatePath}`);
      },
      inspectAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 44),
    })).rejects.toThrow("unavailable");

    expect(await readFile(path, "utf8")).toBe(`${oldToken}\n`);
    expect(await readdir(directory)).toEqual(["bridge-agent-key-v2"]);
  });

  test("reports a committed-but-unverified rotation without leaking credential data", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeAgentTokenPath(codexHome);
    const oldToken = Buffer.alloc(32, 45).toString("base64url");
    const nextToken = Buffer.alloc(32, 46).toString("base64url");
    await mkdir(directory);
    await writeFile(path, `${oldToken}\n`, "utf8");

    let thrown: unknown;
    try {
      await rotateLocalBridgeAgentToken({
        codexHome,
        processPlatform: "win32",
        applyAcl: async () => undefined,
        inspectAcl: async () => undefined,
        randomBytes: () => Buffer.from(nextToken, "base64url"),
        readCredentialFile: async (candidatePath) => {
          const raw = await readFile(candidatePath, "utf8");
          if (candidatePath === path) {
            throw new Error(`readback failed: ${candidatePath} ${nextToken}`);
          }
          return raw;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(
      LocalBridgeAgentTokenRotationCommittedButUnverifiedError,
    );
    expect(thrown).toMatchObject({
      code: "BRIDGE_AGENT_CREDENTIAL_ROTATION_COMMITTED_BUT_UNVERIFIED",
      rotationCommitted: true,
      credentialVerified: false,
    });
    expect(await readFile(path, "utf8")).toBe(`${nextToken}\n`);
    const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
    expect(publicError).not.toContain(nextToken);
    expect(publicError).not.toContain(path);
    expect(publicError).not.toContain(codexHome);
  });

  test.skipIf(process.platform !== "win32")(
    "applies and independently verifies a protected Windows DACL for the agent token",
    { tags: ["platform"], timeout: 30_000 },
    async () => {
      const codexHome = await createCodexHome();
      const path = getLocalBridgeAgentTokenPath(codexHome);
      const token = await loadOrCreateLocalBridgeAgentToken({
        codexHome,
        randomBytes: (size) => Buffer.alloc(size, 51),
      });
      expect(await loadOrCreateLocalBridgeAgentToken({ codexHome })).toBe(token);

      await execFile("icacls.exe", [path, "/grant", "*S-1-5-32-545:(R)"], {
        windowsHide: true,
      });
      await expect(loadOrCreateLocalBridgeAgentToken({ codexHome }))
        .rejects.toBeInstanceOf(LocalBridgeAgentTokenRotationRequiredError);
      expect(await readFile(path, "utf8")).toBe(`${token}\n`);
    },
  );
});

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ui-attach-token-"));
  roots.push(root);
  return root;
}
