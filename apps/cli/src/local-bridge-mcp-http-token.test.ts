import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_COMMITTED_BUT_UNVERIFIED,
  LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_REQUIRED,
  LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE,
  type LocalBridgeMcpHttpAclTargetKind,
  LocalBridgeMcpHttpDesiredIdentityReadError,
  LocalBridgeProtectedAclError,
  LocalBridgeMcpHttpTokenRotationRequiredError,
  LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError,
  LocalBridgeMcpHttpTokenReadError,
  MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
  MEANTHIS_MCP_HTTP_KEY_KIND,
  MEANTHIS_MCP_HTTP_TOKEN_ENV,
  applyLocalBridgeWindowsProtectedAcl,
  fingerprintLocalBridgeMcpHttpToken,
  getLocalBridgeMcpHttpDesiredIdentityPath,
  getLocalBridgeProtectedBuildMarkerPath,
  getLocalBridgeMcpHttpTokenPath,
  inspectLocalBridgeMcpHttpToken,
  inspectLocalBridgeWindowsProtectedAcl,
  loadOrCreateLocalBridgeMcpHttpToken,
  readVerifiedLocalBridgeProtectedBuildMarker,
  readVerifiedLocalBridgeMcpHttpDesiredIdentity,
  readLocalBridgeMcpHttpToken,
  readVerifiedLocalBridgeMcpHttpToken,
  rotateLocalBridgeMcpHttpToken,
  validateLocalBridgeMcpHttpToken,
  writeLocalBridgeProtectedBuildMarker,
  writeLocalBridgeMcpHttpDesiredIdentity,
} from "./local-bridge-mcp-http-token";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local bridge MCP HTTP token", () => {
  test("exports path-bounded generic Windows ACL apply and inspect failures", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const file = join(directory, "acl-target");
    await mkdir(directory);
    await writeFile(file, "bounded", "utf8");

    const checks: Array<{
      operation: "apply" | "inspect";
      run: () => Promise<void>;
    }> = [
      {
        operation: "apply",
        run: () => applyLocalBridgeWindowsProtectedAcl(directory, "file"),
      },
      {
        operation: "inspect",
        run: () => inspectLocalBridgeWindowsProtectedAcl(file, "directory"),
      },
    ];
    for (const check of checks) {
      let thrown: unknown;
      try {
        await check.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LocalBridgeProtectedAclError);
      expect(thrown).toMatchObject({
        code: LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE,
        operation: check.operation,
      });
      expect(`${String(thrown)}\n${JSON.stringify(thrown)}`).not.toContain(codexHome);
    }
  });

  test.each([
    ["apply", "directory", "inheritance"],
    ["apply", "directory", "propagation"],
    ["apply", "file", "inheritance"],
    ["apply", "file", "propagation"],
    ["inspect", "directory", "inheritance"],
    ["inspect", "directory", "propagation"],
    ["inspect", "file", "inheritance"],
    ["inspect", "file", "propagation"],
  ] as const)(
    "%s fails closed when a mocked %s ACL has malformed %s flags",
    async (operation, kind, malformedFlag) => {
      const codexHome = await createCodexHome();
      const targetPath = kind === "directory"
        ? join(codexHome, "acl-target")
        : join(codexHome, "acl-target", "protected-file");
      if (kind === "directory") {
        await mkdir(targetPath);
      } else {
        await mkdir(join(codexHome, "acl-target"));
        await writeFile(targetPath, "bounded", "utf8");
      }

      const aclExecFile = vi.fn(async (
        _host: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        const script = args.at(-1) ?? "";
        const definesExactInheritance =
          script.includes("$inheritance = if ($targetKind -eq 'directory') {") &&
          script.includes(
            "[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
          ) &&
          script.includes("[System.Security.AccessControl.InheritanceFlags]::None");
        const definesExactPropagation = script.includes(
          "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
        );
        const rejectsMalformedInheritance = script.includes(
          "if ([int64]$rule.InheritanceFlags -ne [int64]$inheritance)",
        );
        const rejectsMalformedPropagation = script.includes(
          "if ([int64]$rule.PropagationFlags -ne [int64]$propagation)",
        );
        const rejectsMockedMalformedAcl =
          options.env.MEANTHIS_MCP_ACL_TARGET_KIND === kind &&
          definesExactInheritance &&
          definesExactPropagation &&
          (malformedFlag === "inheritance"
            ? rejectsMalformedInheritance
            : rejectsMalformedPropagation);
        if (rejectsMockedMalformedAcl) {
          throw new Error(`mocked malformed ${malformedFlag} flags`);
        }
      });
      const run = operation === "apply"
        ? applyLocalBridgeWindowsProtectedAcl
        : inspectLocalBridgeWindowsProtectedAcl;

      await expect(run(targetPath, kind, { execFile: aclExecFile }))
        .rejects.toMatchObject({
          code: LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE,
          operation,
        });
      expect(aclExecFile).toHaveBeenCalledTimes(1);
    },
  );

  test("removes the bearer from an ACL child environment without mutating the parent", async () => {
    const codexHome = await createCodexHome();
    const targetPath = join(codexHome, "acl-target");
    const secret = Buffer.alloc(32, 61).toString("base64url");
    const sentinelKey = "MEANTHIS_TEST_ACL_ENV_SENTINEL";
    const sentinelValue = "preserved";
    const previousToken = process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV];
    const previousSentinel = process.env[sentinelKey];
    await mkdir(targetPath);

    let childEnvironment: NodeJS.ProcessEnv | undefined;
    let childArguments: string[] | undefined;
    let thrown: unknown;
    try {
      process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV] = secret;
      process.env[sentinelKey] = sentinelValue;
      const aclExecFile = vi.fn(async (
        _host: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        childArguments = args;
        childEnvironment = options.env;
        throw new Error(`subprocess failure containing ${secret}`);
      });

      try {
        await inspectLocalBridgeWindowsProtectedAcl(targetPath, "directory", {
          execFile: aclExecFile,
        });
      } catch (error) {
        thrown = error;
      }

      expect(aclExecFile).toHaveBeenCalledTimes(1);
      expect(childEnvironment?.[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBeUndefined();
      expect(childEnvironment?.[sentinelKey]).toBe(sentinelValue);
      expect(process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBe(secret);
      expect(process.env[sentinelKey]).toBe(sentinelValue);
      expect(JSON.stringify(childArguments)).not.toContain(secret);
      expect(`${String(thrown)}\n${JSON.stringify(thrown)}`).not.toContain(secret);
      expect(thrown).toMatchObject({
        code: LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE,
        operation: "inspect",
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV];
      } else {
        process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV] = previousToken;
      }
      if (previousSentinel === undefined) {
        delete process.env[sentinelKey];
      } else {
        process.env[sentinelKey] = previousSentinel;
      }
    }
  });

  test("coalesces stable Windows ACL inspections and invalidates the cache on metadata drift", async () => {
    const codexHome = await createCodexHome();
    const targetPath = join(codexHome, "acl-cache-target");
    await writeFile(targetPath, "first", "utf8");
    let releaseInspection!: () => void;
    const aclExecFile = vi.fn(() => new Promise<void>((resolve) => {
      releaseInspection = resolve;
    }));

    const first = inspectLocalBridgeWindowsProtectedAcl(targetPath, "file", {
      execFile: aclExecFile,
    });
    const concurrent = inspectLocalBridgeWindowsProtectedAcl(targetPath, "file", {
      execFile: aclExecFile,
    });
    await vi.waitFor(() => expect(aclExecFile).toHaveBeenCalledTimes(1));
    releaseInspection();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined]);

    await expect(inspectLocalBridgeWindowsProtectedAcl(targetPath, "file", {
      execFile: aclExecFile,
    })).resolves.toBeUndefined();
    expect(aclExecFile).toHaveBeenCalledTimes(1);

    await writeFile(targetPath, "second-value", "utf8");
    aclExecFile.mockImplementation(async () => undefined);
    await expect(inspectLocalBridgeWindowsProtectedAcl(targetPath, "file", {
      execFile: aclExecFile,
    })).resolves.toBeUndefined();
    expect(aclExecFile).toHaveBeenCalledTimes(2);
  });

  test("exposes the canonical environment variable, path, validation, and a non-secret fingerprint", async () => {
    const codexHome = await createCodexHome();
    const token = Buffer.alloc(32, 17).toString("base64url");

    expect(MEANTHIS_MCP_HTTP_TOKEN_ENV).toBe("MEANTHIS_MCP_HTTP_TOKEN");
    expect(MEANTHIS_MCP_HTTP_KEY_KIND).toBe("mcp-http-key-v1");
    expect(getLocalBridgeMcpHttpTokenPath(codexHome))
      .toBe(join(codexHome, "ui-attach", "mcp-http-key-v1"));
    expect(validateLocalBridgeMcpHttpToken(token)).toBe(true);
    expect(validateLocalBridgeMcpHttpToken(`${token}\n`)).toBe(false);
    expect(validateLocalBridgeMcpHttpToken(token.slice(1))).toBe(false);
    expect(validateLocalBridgeMcpHttpToken(`${token}=`)).toBe(false);
    expect(validateLocalBridgeMcpHttpToken(`${token.slice(0, -1)}_`)).toBe(false);

    const fingerprint = fingerprintLocalBridgeMcpHttpToken(token);
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(fingerprint).not.toContain(token);
    expect(fingerprintLocalBridgeMcpHttpToken(token)).toBe(fingerprint);
    expect(() => fingerprintLocalBridgeMcpHttpToken("invalid"))
      .toThrow("invalid");
  });

  test("creates one profile-scoped token with wx semantics and reuses it", async () => {
    const codexHome = await createCodexHome();
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);

    const first = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      randomBytes: (size) => Buffer.alloc(size, 11),
    });
    applyAcl.mockClear();
    const second = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    });

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect(await readFile(getLocalBridgeMcpHttpTokenPath(codexHome), "utf8"))
      .toBe(`${first}\n`);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).toHaveBeenCalledWith(join(codexHome, "ui-attach"), "directory");
    expect(inspectAcl).toHaveBeenCalledWith(getLocalBridgeMcpHttpTokenPath(codexHome), "file");
  });

  test("hardens an existing directory before creating a missing credential", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => {
      throw new Error("missing credentials must not enter the reuse path");
    });
    await mkdir(directory);

    const token = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
      randomBytes: (size) => Buffer.alloc(size, 18),
    });

    expect(await readFile(getLocalBridgeMcpHttpTokenPath(codexHome), "utf8"))
      .toBe(`${token}\n`);
    expect(applyAcl).toHaveBeenCalledWith(directory, "directory");
    expect(applyAcl).toHaveBeenCalledWith(getLocalBridgeMcpHttpTokenPath(codexHome), "file");
    expect(inspectAcl).not.toHaveBeenCalled();
  });

  test("supports a canonical fail-closed read without reapplying ACLs", async () => {
    const codexHome = await createCodexHome();
    const applyAcl = vi.fn(async () => undefined);
    const token = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      randomBytes: (size) => Buffer.alloc(size, 12),
    });
    applyAcl.mockClear();

    expect(await readLocalBridgeMcpHttpToken({ codexHome })).toBe(token);
    expect(applyAcl).not.toHaveBeenCalled();

    await writeFile(getLocalBridgeMcpHttpTokenPath(codexHome), `${token.slice(0, -1)}_\n`, "utf8");
    await expect(readLocalBridgeMcpHttpToken({ codexHome })).rejects.toThrow("invalid");
  });

  test("reads an existing credential only after read-only permission verification", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    const token = Buffer.alloc(32, 41).toString("base64url");
    const inspectAcl = vi.fn(async () => undefined);
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    await expect(readVerifiedLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl,
    })).resolves.toBe(token);
    expect(inspectAcl).toHaveBeenCalledWith(directory, "directory");
    expect(inspectAcl).toHaveBeenCalledWith(path, "file");
  });

  test("fails closed without mutating an insecure or missing credential", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    const token = Buffer.alloc(32, 42).toString("base64url");
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    await expect(readVerifiedLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => { throw new Error(`unsafe ${path} ${token}`); },
    })).rejects.toMatchObject({
      name: "LocalBridgeMcpHttpTokenReadError",
      code: "MCP_HTTP_CREDENTIAL_UNAVAILABLE",
      message: "MCP HTTP credential is unavailable.",
    });
    expect(await readFile(path, "utf8")).toBe(`${token}\n`);

    const missingHome = await createCodexHome();
    await expect(readVerifiedLocalBridgeMcpHttpToken({
      codexHome: missingHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);
    await expect(readFile(getLocalBridgeMcpHttpTokenPath(missingHome), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a credential replaced between permission verification and readback", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    const displacedPath = `${path}.displaced`;
    const token = Buffer.alloc(32, 43).toString("base64url");
    await mkdir(directory);
    await writeFile(path, `${token}\n`, "utf8");

    await expect(readVerifiedLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
      readCredentialFile: async (candidatePath) => {
        const raw = await readFile(candidatePath, "utf8");
        await rename(candidatePath, displacedPath);
        await writeFile(candidatePath, raw, "utf8");
        return raw;
      },
    })).rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);
  });

  test("inspects a credential for doctor without creating, mutating, or returning the token", async () => {
    const missingHome = await createCodexHome();
    expect(await inspectLocalBridgeMcpHttpToken({
      codexHome: missingHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).toEqual({ kind: "mcp-http-key-v1", status: "missing" });
    await expect(readFile(getLocalBridgeMcpHttpTokenPath(missingHome), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const codexHome = await createCodexHome();
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);
    const token = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      randomBytes: (size) => Buffer.alloc(size, 13),
    });
    applyAcl.mockClear();

    const inspection = await inspectLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
    });
    expect(inspection).toEqual({
      kind: "mcp-http-key-v1",
      status: "ready",
      fingerprint: fingerprintLocalBridgeMcpHttpToken(token),
    });
    expect(JSON.stringify(inspection)).not.toContain(token);
    expect(JSON.stringify(inspection)).not.toContain(codexHome);
    expect(applyAcl).not.toHaveBeenCalled();
    expect(inspectAcl).toHaveBeenCalledWith(join(codexHome, "ui-attach"), "directory");
    expect(inspectAcl).toHaveBeenCalledWith(getLocalBridgeMcpHttpTokenPath(codexHome), "file");
  });

  test("reports bounded invalid and insecure doctor states without revealing credential data", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    const malformed = "not-a-valid-token";
    await mkdir(directory);
    await writeFile(path, `${malformed}\n`, "utf8");

    const invalid = await inspectLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    });
    expect(invalid).toEqual({ kind: "mcp-http-key-v1", status: "invalid" });
    expect(JSON.stringify(invalid)).not.toContain(malformed);
    expect(JSON.stringify(invalid)).not.toContain(codexHome);

    await writeFile(path, `${Buffer.alloc(32, 14).toString("base64url")}\n`, "utf8");
    const insecure = await inspectLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => {
        throw new Error(`unsafe ACL at ${path}`);
      },
    });
    expect(insecure).toEqual({ kind: "mcp-http-key-v1", status: "insecure" });
    expect(JSON.stringify(insecure)).not.toContain(path);
  });

  test("concurrent creators converge on the one wx-created credential", async () => {
    const codexHome = await createCodexHome();
    const applyAcl = vi.fn(async () => undefined);
    const inspectAcl = vi.fn(async () => undefined);
    const firstToken = Buffer.alloc(32, 21).toString("base64url");
    const secondToken = Buffer.alloc(32, 22).toString("base64url");

    const [first, second] = await Promise.all([
      loadOrCreateLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: "win32",
        applyAcl,
        inspectAcl,
        randomBytes: () => Buffer.from(firstToken, "base64url"),
      }),
      loadOrCreateLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: "win32",
        applyAcl,
        inspectAcl,
        randomBytes: () => Buffer.from(secondToken, "base64url"),
      }),
    ]);

    expect(first).toBe(second);
    expect([firstToken, secondToken]).toContain(first);
    expect(await readFile(getLocalBridgeMcpHttpTokenPath(codexHome), "utf8"))
      .toBe(`${first}\n`);
  });

  test("fails closed without replacing a malformed existing credential", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    await mkdir(directory);
    await writeFile(path, "not-a-valid-token\n", "utf8");

    await expect(loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).rejects.toThrow("invalid");
    await expect(readVerifiedLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      inspectAcl: async () => undefined,
    })).rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);
    expect(await readFile(path, "utf8")).toBe("not-a-valid-token\n");
  });

  test("removes only a token created by this call when its ACL hardening fails", async () => {
    const codexHome = await createCodexHome();
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);

    await expect(loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (_path, kind) => {
        if (kind === "file") throw new Error("ACL failure");
      },
      randomBytes: (size) => Buffer.alloc(size, 24),
    })).rejects.toThrow("ACL failure");

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["directory", "file"] as const)(
    "fails closed without hardening or reusing an existing token with an insecure %s ACL",
    async (insecureKind) => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const path = getLocalBridgeMcpHttpTokenPath(codexHome);
      const token = Buffer.alloc(32, 25).toString("base64url");
      const applyAcl = vi.fn(async () => undefined);
      const inspectAcl = vi.fn(async (candidatePath: string, kind: "directory" | "file") => {
        if (kind === insecureKind) {
          throw new Error(`insecure ${kind} at ${candidatePath}: ${token}`);
        }
      });
      await mkdir(directory);
      await writeFile(path, `${token}\n`, "utf8");

      let thrown: unknown;
      try {
        await loadOrCreateLocalBridgeMcpHttpToken({
          codexHome,
          processPlatform: "win32",
          applyAcl,
          inspectAcl,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LocalBridgeMcpHttpTokenRotationRequiredError);
      expect(thrown).toMatchObject({
        status: LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_REQUIRED,
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

  test.skipIf(process.platform === "win32")(
    "rejects a symbolic-link credential and symbolic-link storage directory",
    async () => {
      const codexHome = await createCodexHome();
      const outside = join(codexHome, "outside");
      const directory = join(codexHome, "ui-attach");
      await mkdir(directory);
      await writeFile(outside, `${Buffer.alloc(32, 4).toString("base64url")}\n`, "utf8");
      await symlink(outside, getLocalBridgeMcpHttpTokenPath(codexHome));

      await expect(loadOrCreateLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: process.platform,
      })).rejects.toThrow("invalid");
      await expect(readVerifiedLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: process.platform,
      })).rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);

      const secondHome = await createCodexHome();
      const linkedDirectory = join(secondHome, "linked-directory");
      await mkdir(linkedDirectory);
      await symlink(linkedDirectory, join(secondHome, "ui-attach"), "dir");
      await expect(loadOrCreateLocalBridgeMcpHttpToken({
        codexHome: secondHome,
        processPlatform: process.platform,
      })).rejects.toThrow("invalid");
      await expect(readVerifiedLocalBridgeMcpHttpToken({
        codexHome: secondHome,
        processPlatform: process.platform,
      })).rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);

      const thirdHome = await createCodexHome();
      const thirdDirectory = join(thirdHome, "ui-attach");
      const thirdOutside = join(thirdHome, "outside");
      const outsideToken = Buffer.alloc(32, 5).toString("base64url");
      await mkdir(thirdDirectory);
      await writeFile(thirdOutside, `${outsideToken}\n`, "utf8");
      await symlink(thirdOutside, getLocalBridgeMcpHttpTokenPath(thirdHome));

      const rotatedToken = await rotateLocalBridgeMcpHttpToken({
        codexHome: thirdHome,
        processPlatform: process.platform,
        randomBytes: (size) => Buffer.alloc(size, 6),
      });

      expect(await readFile(thirdOutside, "utf8")).toBe(`${outsideToken}\n`);
      expect(await readFile(getLocalBridgeMcpHttpTokenPath(thirdHome), "utf8"))
        .toBe(`${rotatedToken}\n`);
      expect((await stat(getLocalBridgeMcpHttpTokenPath(thirdHome))).mode & 0o777)
        .toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "fails closed on insecure existing Unix modes and repairs only through rotation",
    async () => {
      const codexHome = await createCodexHome();
      const oldToken = await loadOrCreateLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: process.platform,
        randomBytes: (size) => Buffer.alloc(size, 31),
      });

      expect((await stat(join(codexHome, "ui-attach"))).mode & 0o777).toBe(0o700);
      expect((await stat(getLocalBridgeMcpHttpTokenPath(codexHome))).mode & 0o777).toBe(0o600);

      await chmod(getLocalBridgeMcpHttpTokenPath(codexHome), 0o644);
      await expect(loadOrCreateLocalBridgeMcpHttpToken({ codexHome }))
        .rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenRotationRequiredError);
      await expect(readVerifiedLocalBridgeMcpHttpToken({ codexHome }))
        .rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);
      expect(await readFile(getLocalBridgeMcpHttpTokenPath(codexHome), "utf8"))
        .toBe(`${oldToken}\n`);
      expect((await stat(getLocalBridgeMcpHttpTokenPath(codexHome))).mode & 0o777).toBe(0o644);

      const rotatedToken = await rotateLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: process.platform,
        randomBytes: (size) => Buffer.alloc(size, 32),
      });
      expect(rotatedToken).not.toBe(oldToken);
      expect((await stat(getLocalBridgeMcpHttpTokenPath(codexHome))).mode & 0o777).toBe(0o600);

      const secondHome = await createCodexHome();
      const secondDirectory = join(secondHome, "ui-attach");
      const secondPath = getLocalBridgeMcpHttpTokenPath(secondHome);
      const secondOldToken = await loadOrCreateLocalBridgeMcpHttpToken({
        codexHome: secondHome,
        randomBytes: (size) => Buffer.alloc(size, 33),
      });
      await chmod(secondDirectory, 0o755);

      await expect(loadOrCreateLocalBridgeMcpHttpToken({ codexHome: secondHome }))
        .rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenRotationRequiredError);
      expect(await readFile(secondPath, "utf8")).toBe(`${secondOldToken}\n`);
      expect((await stat(secondDirectory)).mode & 0o777).toBe(0o755);

      const secondRotatedToken = await rotateLocalBridgeMcpHttpToken({
        codexHome: secondHome,
        randomBytes: (size) => Buffer.alloc(size, 34),
      });
      expect(secondRotatedToken).not.toBe(secondOldToken);
      expect((await stat(secondDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(secondPath)).mode & 0o777).toBe(0o600);

      const thirdHome = await createCodexHome();
      const thirdDirectory = join(thirdHome, "ui-attach");
      await mkdir(thirdDirectory, { mode: 0o755 });
      await chmod(thirdDirectory, 0o755);
      await loadOrCreateLocalBridgeMcpHttpToken({
        codexHome: thirdHome,
        randomBytes: (size) => Buffer.alloc(size, 35),
      });
      expect((await stat(thirdDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(getLocalBridgeMcpHttpTokenPath(thirdHome))).mode & 0o777)
        .toBe(0o600);
    },
  );

  test("rotates by atomic replacement without retaining the old value or a backup", async () => {
    const codexHome = await createCodexHome();
    const applyAcl = vi.fn(async () => undefined);
    const oldToken = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      randomBytes: (size) => Buffer.alloc(size, 1),
    });
    applyAcl.mockClear();
    const newToken = await rotateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl,
      randomBytes: (size) => Buffer.alloc(size, 2),
    });

    expect(newToken).not.toBe(oldToken);
    expect(await readFile(getLocalBridgeMcpHttpTokenPath(codexHome), "utf8"))
      .toBe(`${newToken}\n`);
    expect((await readdir(join(codexHome, "ui-attach"))).sort())
      .toEqual(["mcp-http-key-v1"]);
    expect(applyAcl).toHaveBeenCalledTimes(2);
    expect(applyAcl).toHaveBeenNthCalledWith(1, join(codexHome, "ui-attach"), "directory");
    const hardenedPath = applyAcl.mock.calls[1]?.[0];
    expect(hardenedPath).toMatch(/\.mcp-http-key-v1\.\d+\.[a-f0-9]+\.tmp$/u);
    expect(hardenedPath).not.toBe(getLocalBridgeMcpHttpTokenPath(codexHome));
  });

  test("keeps the old credential and removes the temporary file if rotation hardening fails", async () => {
    const codexHome = await createCodexHome();
    const oldToken = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    await expect(rotateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async (_path, kind) => {
        if (kind === "file") throw new Error("ACL failure");
      },
      randomBytes: (size) => Buffer.alloc(size, 8),
    })).rejects.toThrow("ACL failure");

    expect(await readFile(getLocalBridgeMcpHttpTokenPath(codexHome), "utf8"))
      .toBe(`${oldToken}\n`);
    expect((await readdir(join(codexHome, "ui-attach"))).sort())
      .toEqual(["mcp-http-key-v1"]);
  });

  test("reports a committed-but-unverified rotation without leaking the token or credential path", async () => {
    const codexHome = await createCodexHome();
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    const oldToken = await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 9),
    });
    const nextToken = Buffer.alloc(32, 10).toString("base64url");
    const readPaths: string[] = [];

    let thrown: unknown;
    try {
      await rotateLocalBridgeMcpHttpToken({
        codexHome,
        processPlatform: "win32",
        applyAcl: async () => undefined,
        randomBytes: () => Buffer.from(nextToken, "base64url"),
        readCredentialFile: async (candidatePath) => {
          readPaths.push(candidatePath);
          if (candidatePath === path) {
            throw new Error(`readback failed for ${candidatePath}: ${nextToken}`);
          }
          return readFile(candidatePath, "utf8");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(
      LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError,
    );
    expect(thrown).toMatchObject({
      status: LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_COMMITTED_BUT_UNVERIFIED,
      rotationCommitted: true,
      credentialVerified: false,
    });
    expect(readPaths).toHaveLength(2);
    expect(readPaths[0]).not.toBe(path);
    expect(readPaths[1]).toBe(path);
    expect(await readFile(path, "utf8")).toBe(`${nextToken}\n`);
    expect(await readFile(path, "utf8")).not.toContain(oldToken);
    expect((await readdir(join(codexHome, "ui-attach"))).sort())
      .toEqual(["mcp-http-key-v1"]);

    const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
    expect(publicError).toContain("rotation committed");
    expect(publicError).not.toContain(nextToken);
    expect(publicError).not.toContain(oldToken);
    expect(publicError).not.toContain(path);
    expect(publicError).not.toContain(codexHome);
  });

  test("does not remove a concurrent rotation winner after detecting a committed token mismatch", async () => {
    const codexHome = await createCodexHome();
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      randomBytes: (size) => Buffer.alloc(size, 15),
    });
    const firstToken = Buffer.alloc(32, 16).toString("base64url");
    const winnerToken = Buffer.alloc(32, 17).toString("base64url");
    let reportFirstCommit!: () => void;
    const firstCommitReached = new Promise<void>((resolve) => {
      reportFirstCommit = resolve;
    });
    let releaseFirstRead!: () => void;
    const firstReadReleased = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });

    const firstRotation = rotateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      randomBytes: () => Buffer.from(firstToken, "base64url"),
      readCredentialFile: async (candidatePath) => {
        if (candidatePath === path) {
          reportFirstCommit();
          await firstReadReleased;
        }
        return readFile(candidatePath, "utf8");
      },
    });

    await firstCommitReached;
    expect(await readFile(path, "utf8")).toBe(`${firstToken}\n`);
    expect(await rotateLocalBridgeMcpHttpToken({
      codexHome,
      processPlatform: "win32",
      applyAcl: async () => undefined,
      randomBytes: () => Buffer.from(winnerToken, "base64url"),
    })).toBe(winnerToken);
    releaseFirstRead();

    await expect(firstRotation).rejects.toBeInstanceOf(
      LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError,
    );
    expect(await readFile(path, "utf8")).toBe(`${winnerToken}\n`);
    expect((await readdir(join(codexHome, "ui-attach"))).sort())
      .toEqual(["mcp-http-key-v1"]);
  });

  test.runIf(process.platform === "win32")(
    "applies and independently verifies a protected Windows DACL in a temporary profile",
    { tags: ["platform"], timeout: 30_000 },
    async () => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const path = getLocalBridgeMcpHttpTokenPath(codexHome);
      const oldToken = await loadOrCreateLocalBridgeMcpHttpToken({
        codexHome,
        randomBytes: (size) => Buffer.alloc(size, 29),
      });
      await execFile("icacls.exe", [path, "/grant", "*S-1-5-32-545:(R)"], {
        windowsHide: true,
      });
      expect(await inspectLocalBridgeMcpHttpToken({ codexHome }))
        .toEqual({ kind: "mcp-http-key-v1", status: "insecure" });
      await expect(loadOrCreateLocalBridgeMcpHttpToken({ codexHome }))
        .rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenRotationRequiredError);
      await expect(readVerifiedLocalBridgeMcpHttpToken({ codexHome }))
        .rejects.toBeInstanceOf(LocalBridgeMcpHttpTokenReadError);
      expect(await readFile(path, "utf8")).toBe(`${oldToken}\n`);
      expect(await inspectLocalBridgeMcpHttpToken({ codexHome }))
        .toEqual({ kind: "mcp-http-key-v1", status: "insecure" });

      const rotatedToken = await rotateLocalBridgeMcpHttpToken({
        codexHome,
        randomBytes: (size) => Buffer.alloc(size, 30),
      });
      expect(rotatedToken).not.toBe(oldToken);
      expect(await inspectLocalBridgeMcpHttpToken({ codexHome })).toMatchObject({
        kind: "mcp-http-key-v1",
        status: "ready",
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      });
      await expect(readVerifiedLocalBridgeMcpHttpToken({ codexHome }))
        .resolves.toBe(rotatedToken);

      const probe = [
        "$ErrorActionPreference = 'Stop'",
        "$acl = Get-Acl -LiteralPath $env:MEANTHIS_TEST_ACL_PATH",
        "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
        "$result = [ordered]@{ protected = $acl.AreAccessRulesProtected; rules = @($rules | ForEach-Object { [ordered]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inheritance = [int64]$_.InheritanceFlags; propagation = [int64]$_.PropagationFlags } }) }",
        "$result | ConvertTo-Json -Depth 4 -Compress",
      ].join(";");
      const host = await findPowerShellHost();
      const currentSid = await getCurrentWindowsSid(host);
      for (const [kind, targetPath] of [
        ["directory", directory],
        ["file", path],
      ] as const) {
        const { stdout } = await execFile(host, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          probe,
        ], {
          env: { ...process.env, MEANTHIS_TEST_ACL_PATH: targetPath },
          windowsHide: true,
        });
        const result = JSON.parse(stdout) as {
          protected: boolean;
          rules: Array<{
            sid: string;
            inherited: boolean;
            type: string;
            rights: string;
            inheritance: number;
            propagation: number;
          }>;
        };

        expect(result.protected).toBe(true);
        expect(result.rules).toHaveLength(2);
        expect(result.rules.map((rule) => rule.sid).sort())
          .toEqual(["S-1-5-18", currentSid].sort());
        expect(result.rules.every((rule) => !rule.inherited && rule.type === "Allow" && rule.rights === "FullControl"))
          .toBe(true);
        expect(result.rules.every((rule) =>
          rule.inheritance === (kind === "directory" ? 3 : 0) &&
          rule.propagation === 0
        )).toBe(true);
      }
    },
  );
});

describe("local bridge MCP HTTP desired identity", () => {
  test("creates and protects a missing marker directory before publishing", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
    const buildHash = "8".repeat(64);
    const applyAcl = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);
    const inspectAcl = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);

    await writeLocalBridgeMcpHttpDesiredIdentity(buildHash, {
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
      randomBytes: (size) => Buffer.alloc(size, 48),
    });

    expect(applyAcl).toHaveBeenCalledWith(directory, "directory");
    expect(applyAcl.mock.calls.some(([path, kind]) =>
      path !== directory && kind === "file"
    )).toBe(true);
    expect(inspectAcl).toHaveBeenCalledWith(directory, "directory");
    expect(inspectAcl).toHaveBeenCalledWith(markerPath, "file");
    expect(await readFile(markerPath, "utf8")).toBe(`${buildHash}\n`);
  });

  test("bounds a failed new-directory hardening without exposing the profile path or value", async () => {
    const codexHome = await createCodexHome();
    const buildHash = "7".repeat(64);
    let thrown: unknown;

    try {
      await writeLocalBridgeMcpHttpDesiredIdentity(buildHash, {
        codexHome,
        processPlatform: "win32",
        applyAcl: async (path, kind) => {
          throw new Error(`failed ${kind} ACL at ${path}: ${buildHash}`);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LocalBridgeMcpHttpDesiredIdentityReadError);
    const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
    expect(publicError).not.toContain(codexHome);
    expect(publicError).not.toContain(buildHash);
    expect(await readdir(codexHome)).toEqual([]);
  });

  test("verifies the Windows marker directory and hardens the temporary file before verifying the committed marker", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
    const buildHash = "a".repeat(64);
    const applyAcl = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);
    const inspectAcl = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);
    await mkdir(directory);

    await writeLocalBridgeMcpHttpDesiredIdentity(buildHash, {
      codexHome,
      processPlatform: "win32",
      applyAcl,
      inspectAcl,
      randomBytes: (size) => Buffer.alloc(size, 44),
    });

    expect(applyAcl).not.toHaveBeenCalledWith(directory, "directory");
    const hardenedFilePaths = applyAcl.mock.calls
      .filter(([, kind]) => kind === "file")
      .map(([path]) => path);
    expect(hardenedFilePaths).toHaveLength(1);
    expect(hardenedFilePaths[0]).toMatch(
      /\.mcp-http-owner-desired-build-v1\.\d+\.[a-f0-9]+\.tmp$/u,
    );
    expect(hardenedFilePaths[0]).not.toBe(markerPath);
    expect(inspectAcl).toHaveBeenCalledWith(directory, "directory");
    expect(inspectAcl).toHaveBeenCalledWith(markerPath, "file");
    const inspectionsAfterWrite = inspectAcl.mock.calls.length;
    expect(inspectionsAfterWrite).toBeGreaterThanOrEqual(2);
    await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({
      codexHome,
      processPlatform: "win32",
      inspectAcl,
    })).resolves.toBe(buildHash);
    expect(inspectAcl).toHaveBeenCalledTimes(inspectionsAfterWrite);
    await expect(readFile(markerPath, "utf8")).resolves.toBe(`${buildHash}\n`);
    expect((await readdir(directory)).sort())
      .toEqual(["mcp-http-owner-desired-build-v1"]);
  });

  test.each(["directory", "file"] as const)(
    "fails closed without mutating a marker whose Windows %s ACL is insecure or unverifiable",
    async (insecureKind) => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
      const buildHash = "b".repeat(64);
      await mkdir(directory);
      await writeFile(markerPath, `${buildHash}\n`, "utf8");

      let thrown: unknown;
      try {
        await readVerifiedLocalBridgeMcpHttpDesiredIdentity({
          codexHome,
          processPlatform: "win32",
          inspectAcl: async (_path, kind) => {
            if (kind === insecureKind) {
              throw new Error(`unsafe ACL at ${markerPath}: ${buildHash}`);
            }
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LocalBridgeMcpHttpDesiredIdentityReadError);
      expect(thrown).toMatchObject({
        code: "MCP_HTTP_DESIRED_IDENTITY_UNAVAILABLE",
        message: "MCP HTTP desired identity is unavailable.",
      });
      expect(await readFile(markerPath, "utf8")).toBe(`${buildHash}\n`);
      const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
      expect(publicError).not.toContain(buildHash);
      expect(publicError).not.toContain(markerPath);
      expect(publicError).not.toContain(codexHome);
    },
  );

  test("fails closed when the Windows marker ACL drifts after the bounded read", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
    const buildHash = "f".repeat(64);
    let fileInspections = 0;
    await mkdir(directory);
    await writeFile(markerPath, `${buildHash}\n`, "utf8");

    await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({
      codexHome,
      processPlatform: "win32",
      disableAclInspectionCache: true,
      inspectAcl: async (_path, kind) => {
        if (kind === "file" && ++fileInspections === 2) {
          throw new Error(`ACL drift at ${markerPath}: ${buildHash}`);
        }
      },
    })).rejects.toBeInstanceOf(LocalBridgeMcpHttpDesiredIdentityReadError);
    expect(fileInspections).toBe(2);
    expect(await readFile(markerPath, "utf8")).toBe(`${buildHash}\n`);
  });

  test("rechecks a cached Windows ACL when marker metadata identity changes", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
    const buildHash = "0".repeat(64);
    const inspectAcl = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);
    await mkdir(directory);
    await writeFile(markerPath, `${buildHash}\n`, "utf8");

    await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({
      codexHome,
      processPlatform: "win32",
      inspectAcl,
    })).resolves.toBe(buildHash);
    expect(inspectAcl).toHaveBeenCalledTimes(2);

    await chmod(markerPath, 0o444);
    try {
      await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({
        codexHome,
        processPlatform: "win32",
        inspectAcl,
      })).resolves.toBe(buildHash);
      expect(inspectAcl.mock.calls.filter(([, kind]) => kind === "directory"))
        .toHaveLength(1);
      expect(inspectAcl.mock.calls.filter(([, kind]) => kind === "file"))
        .toHaveLength(2);
    } finally {
      await chmod(markerPath, 0o600);
    }
  });

  test("does not reuse a Windows ACL cache entry across different inspectors", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
    const buildHash = "9".repeat(64);
    const firstInspector = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);
    const secondInspector = vi.fn(async (
      _path: string,
      _kind: LocalBridgeMcpHttpAclTargetKind,
    ) => undefined);
    await mkdir(directory);
    await writeFile(markerPath, `${buildHash}\n`, "utf8");

    await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({
      codexHome,
      processPlatform: "win32",
      inspectAcl: firstInspector,
    })).resolves.toBe(buildHash);
    await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({
      codexHome,
      processPlatform: "win32",
      inspectAcl: secondInspector,
    })).resolves.toBe(buildHash);
    expect(firstInspector).toHaveBeenCalledTimes(2);
    expect(secondInspector).toHaveBeenCalledTimes(2);
  });

  test("limits the reusable protected marker primitive to fixed profile basenames", async () => {
    const codexHome = await createCodexHome();
    const directory = join(codexHome, "ui-attach");
    const browserMarkerPath = getLocalBridgeProtectedBuildMarkerPath(
      MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
      codexHome,
    );
    const buildHash = "1".repeat(64);
    const securityOptions = {
      codexHome,
      processPlatform: "win32" as const,
      applyAcl: async () => undefined,
      inspectAcl: async () => undefined,
      randomBytes: (size: number) => Buffer.alloc(size, 46),
    };
    await mkdir(directory);

    await writeLocalBridgeProtectedBuildMarker(
      buildHash,
      MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
      securityOptions,
    );
    await expect(readVerifiedLocalBridgeProtectedBuildMarker(
      MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
      securityOptions,
    )).resolves.toBe(buildHash);
    await expect(writeLocalBridgeProtectedBuildMarker(
      "2".repeat(64),
      "../mcp-http-key-v1" as typeof MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
      securityOptions,
    )).rejects.toBeInstanceOf(LocalBridgeMcpHttpDesiredIdentityReadError);
    expect((await readdir(directory)).sort())
      .toEqual([MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME]);
    expect(await readFile(browserMarkerPath, "utf8")).toBe(`${buildHash}\n`);
  });

  test.each(["directory", "file"] as const)(
    "keeps the previous marker and removes any temporary file when Windows %s ACL enforcement fails",
    async (failingKind) => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
      const oldBuildHash = "c".repeat(64);
      const nextBuildHash = "d".repeat(64);
      await mkdir(directory);
      await writeFile(markerPath, `${oldBuildHash}\n`, "utf8");

      let thrown: unknown;
      try {
        await writeLocalBridgeMcpHttpDesiredIdentity(nextBuildHash, {
          codexHome,
          processPlatform: "win32",
          applyAcl: async (_path, kind) => {
            if (failingKind === "file" && kind === "file") {
              throw new Error(`ACL hardening failed at ${markerPath}: ${nextBuildHash}`);
            }
          },
          inspectAcl: async (_path, kind) => {
            if (failingKind === "directory" && kind === "directory") {
              throw new Error(`ACL inspection failed at ${markerPath}: ${nextBuildHash}`);
            }
          },
          randomBytes: (size) => Buffer.alloc(size, 45),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        name: "LocalBridgeMcpHttpDesiredIdentityReadError",
        code: "MCP_HTTP_DESIRED_IDENTITY_UNAVAILABLE",
        message: "MCP HTTP desired identity is unavailable.",
      });

      expect(await readFile(markerPath, "utf8")).toBe(`${oldBuildHash}\n`);
      expect((await readdir(directory)).sort())
        .toEqual(["mcp-http-owner-desired-build-v1"]);
      const publicError = `${String(thrown)}\n${JSON.stringify(thrown)}`;
      expect(publicError).not.toContain(nextBuildHash);
      expect(publicError).not.toContain(markerPath);
      expect(publicError).not.toContain(codexHome);
    },
  );

  test.runIf(process.platform === "win32")(
    "applies and rejects drift from a protected Windows marker DACL in a temporary profile",
    { tags: ["platform"], timeout: 60_000 },
    async () => {
      const codexHome = await createCodexHome();
      const directory = join(codexHome, "ui-attach");
      const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
      const buildHash = "e".repeat(64);
      await loadOrCreateLocalBridgeMcpHttpToken({
        codexHome,
        randomBytes: (size) => Buffer.alloc(size, 47),
      });

      await writeLocalBridgeMcpHttpDesiredIdentity(buildHash, { codexHome });
      await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({ codexHome }))
        .resolves.toBe(buildHash);

      const probe = [
        "$ErrorActionPreference = 'Stop'",
        "$acl = Get-Acl -LiteralPath $env:MEANTHIS_TEST_ACL_PATH",
        "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
        "$result = [ordered]@{ protected = $acl.AreAccessRulesProtected; rules = @($rules | ForEach-Object { [ordered]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inheritance = [int64]$_.InheritanceFlags; propagation = [int64]$_.PropagationFlags } }) }",
        "$result | ConvertTo-Json -Depth 4 -Compress",
      ].join(";");
      const host = await findPowerShellHost();
      const currentSid = await getCurrentWindowsSid(host);
      for (const [kind, targetPath] of [
        ["directory", directory],
        ["file", markerPath],
      ] as const) {
        const { stdout } = await execFile(host, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          probe,
        ], {
          env: { ...process.env, MEANTHIS_TEST_ACL_PATH: targetPath },
          windowsHide: true,
        });
        const result = JSON.parse(stdout) as {
          protected: boolean;
          rules: Array<{
            sid: string;
            inherited: boolean;
            type: string;
            rights: string;
            inheritance: number;
            propagation: number;
          }>;
        };

        expect(result.protected).toBe(true);
        expect(result.rules).toHaveLength(2);
        expect(result.rules.map((rule) => rule.sid).sort())
          .toEqual(["S-1-5-18", currentSid].sort());
        expect(result.rules.every((rule) =>
          !rule.inherited && rule.type === "Allow" && rule.rights === "FullControl"
        )).toBe(true);
        expect(result.rules.every((rule) =>
          rule.inheritance === (kind === "directory" ? 3 : 0) &&
          rule.propagation === 0
        )).toBe(true);
      }

      await execFile("icacls.exe", [markerPath, "/grant", "*S-1-5-32-545:(R)"], {
        windowsHide: true,
      });
      await expect(readVerifiedLocalBridgeMcpHttpDesiredIdentity({ codexHome }))
        .rejects.toBeInstanceOf(LocalBridgeMcpHttpDesiredIdentityReadError);
      expect(await readFile(markerPath, "utf8")).toBe(`${buildHash}\n`);
    },
  );
});

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meanthis-mcp-http-token-"));
  roots.push(root);
  return root;
}

async function findPowerShellHost(): Promise<string> {
  for (const host of ["pwsh.exe", "powershell.exe"]) {
    try {
      await execFile(host, ["-NoProfile", "-NonInteractive", "-Command", "$null"], {
        windowsHide: true,
      });
      return host;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("PowerShell is required for the Windows ACL integration test.");
}

async function getCurrentWindowsSid(host: string): Promise<string> {
  const { stdout } = await execFile(host, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ], { windowsHide: true });
  return stdout.trim();
}
