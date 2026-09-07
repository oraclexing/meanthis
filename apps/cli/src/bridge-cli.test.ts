import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createLocalBridgeConnectionCode } from "@meanthis/schema";
import {
  runBridgeCli,
  acquireMeanThisBridgeProfileLock,
  MeanThisBridgeProfileLockError,
  runProcess,
  secureCodexConfigBackup,
  waitForRunProcessChildClose,
  type BridgeCliDependencies,
  type BridgeCliIo,
  type CodexProcessResult,
  type RunProcessChild,
  type RunProcessSpawnOptions,
} from "./bridge-cli";
import {
  LocalBridgeConnectionInvitationExpiredError,
} from "./local-bridge-mcp";
import {
  fingerprintLocalBridgeAgentToken,
  LocalBridgeAgentTokenRotationCommittedButUnverifiedError,
  LocalBridgeAgentTokenRotationRequiredError,
} from "./local-bridge-agent-token";
import {
  LocalBridgeMcpHttpLegacyForegroundOwnerError,
  LocalBridgeMcpHttpUnverifiedListenerError,
} from "./local-bridge-mcp-http-owner";
import {
  LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError,
  LocalBridgeMcpHttpTokenRotationRequiredError,
} from "./local-bridge-mcp-http-token";

const NODE_PATH = resolve("fixtures", "MeanThis path & (test)", "node executable");
const ENTRY_PATH = resolve("fixtures", "MeanThis 路径 & (test)", "dist", "index.js");
const BROKER_ENTRY_PATH = resolve(
  "fixtures",
  "MeanThis 路径 & (test)",
  "dist",
  "local-bridge-mcp-stdio-broker.js",
);
const RESOLVER_ENTRY_PATH = resolve("fixtures", "MeanThis 路径 & (test)", "resolver", "cli.js");
const APPROVAL_KEY = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
const CONNECTION_CODE = createLocalBridgeConnectionCode({
  requestId: "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
  approvalMode: "ask",
  approvalKey: APPROVAL_KEY,
});
const MCP_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const AGENT_TOKEN = Buffer.alloc(32, 2).toString("base64url");
const DRIFTED_AGENT_TOKEN = Buffer.alloc(32, 3).toString("base64url");
const MCP_URL = "http://127.0.0.1:38472/mcp";
const MCP_TOKEN_ENV = "MEANTHIS_MCP_HTTP_TOKEN";
const UNVERIFIED_LISTENER_GUIDANCE =
  "Stop the process that owns 127.0.0.1:38472 manually, then run meanthis bridge start --json.";

describe("meanthis bridge CLI", () => {
  test("installs the current-user browser companion without touching Codex registration", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(
      ["install-native-host", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.installNativeHost).toHaveBeenCalledOnce();
    expect(harness.runCodex).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stdout)).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.native-host-installed",
      ok: true,
      data: { status: "installed", browsers: ["chrome", "edge"] },
    });
  });

  test("accepts one browser-created connection invitation without exposing credentials", async () => {
    const harness = createHarness();
    const requestId = "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58";

    const exitCode = await runBridgeCli([
      "accept",
      CONNECTION_CODE,
      "--json",
    ], harness.io, harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.approveConnectionRequest).toHaveBeenCalledWith(requestId, "ask", APPROVAL_KEY);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-connection-accepted",
      ok: true,
      data: { requestId, approvalMode: "ask" },
      nextAction: {
        kind: "list_captures",
        preferred: { transport: "mcp", tool: "meanthis_list_captures", arguments: {} },
      },
    });
    expect(harness.io.stdout).not.toMatch(/token|requestSecret/iu);
  });

  test("reports an expired browser-created connection invitation distinctly", async () => {
    const harness = createHarness();
    harness.approveConnectionRequest.mockRejectedValueOnce(
      new LocalBridgeConnectionInvitationExpiredError(),
    );

    expect(await runBridgeCli([
      "accept",
      CONNECTION_CODE,
      "--json",
    ], harness.io, harness.dependencies)).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "CONNECTION_INVITATION_EXPIRED",
        message: expect.stringContaining("expired"),
      },
    });
  });

  test("rejects the unpublished expanded invitation syntax", async () => {
    const harness = createHarness();
    const exitCode = await runBridgeCli([
      "accept",
      "--invitation",
      "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
      "--mode",
      "ask",
      "--key",
      APPROVAL_KEY,
      "--json",
    ], harness.io, harness.dependencies);

    expect(exitCode).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(harness.approveConnectionRequest).not.toHaveBeenCalled();
  });

  test("rejects the unpublished approve alias", async () => {
    const harness = createHarness();
    const exitCode = await runBridgeCli([
      "approve",
      CONNECTION_CODE,
      "--json",
    ], harness.io, harness.dependencies);

    expect(exitCode).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(harness.approveConnectionRequest).not.toHaveBeenCalled();
  });

  test("generates a host-neutral thin stdio broker descriptor without embedding credentials", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(
      ["config", "--host", "cursor", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-config",
      ok: true,
      data: {
        descriptor: {
          name: "meanthis",
          transport: {
            type: "stdio",
            command: NODE_PATH,
            args: [BROKER_ENTRY_PATH],
            env: null,
            cwd: null,
          },
        },
        setup: {
          host: "cursor",
          installation: "manual",
          verification: "manual_required",
          artifact: "manual",
          command: null,
          readback: null,
          manual: {
            transport: "stdio",
            command: NODE_PATH,
            args: [BROKER_ENTRY_PATH],
            env: null,
            cwd: null,
          },
        },
      },
    });
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
    expect(harness.io.stdout).not.toContain(MCP_TOKEN_ENV);
  });

  test("doctor is inspect-only and reports exact remediation for missing setup", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-doctor",
      ok: true,
      data: {
        registrationReady: false,
        runtimeActive: false,
        requiresFreshHostProcess: false,
        checks: {
          registration: { status: "missing" },
          credential: { status: "missing" },
          browserOwner: { status: "not_running", next: "Run meanthis bridge start --json." },
          mcpHttpOwner: { status: "blocked", next: "Run meanthis bridge start --json." },
        },
      },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(3);
    expect(harness.inspectMcpHttpCredential).toHaveBeenCalledTimes(1);
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
  });

  test("doctor distinguishes a stale HTTP owner and never repairs it", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      browserHealth: "ready",
      mcpHealth: "stale_build",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        registrationReady: true,
        runtimeActive: false,
        requiresFreshHostProcess: false,
        checks: {
          mcpHttpOwner: {
            status: "stale_build",
            next: "Run meanthis bridge start --json.",
          },
        },
      },
    });
    expect(harness.readMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
  });

  test("doctor identifies a legacy foreground HTTP server with an actionable stop step", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      browserHealth: "ready",
      mcpHealth: "legacy_foreground",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        registrationReady: true,
        runtimeActive: false,
        checks: {
          mcpHttpOwner: {
            status: "legacy_foreground",
            next: expect.stringContaining("Stop the foreground meanthis mcp-http process"),
          },
        },
      },
    });
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
  });

  test("doctor reports an unverified listener with manual stop-port guidance", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      browserHealth: "ready",
      mcpHealth: "unverified_listener",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        runtimeActive: false,
        checks: {
          mcpHttpOwner: {
            status: "unverified_listener",
            next: UNVERIFIED_LISTENER_GUIDANCE,
          },
        },
      },
    });
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
  });

  test.each([
    ["legacy ui-attach", { legacyRegistration: createManagedMainStdioRegistration("ui-attach") }],
    ["standalone resolver", { resolverRegistration: createManagedResolverStdioRegistration() }],
  ])("doctor keeps registrationReady false until the %s registration is removed", async (
    _label,
    registrations,
  ) => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      browserHealth: "ready",
      mcpHealth: "ready",
      ...registrations,
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: { registrationReady: false, runtimeActive: true },
    });
  });

  test("doctor reports the exact broker registration and ready shared daemon without host env", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      browserHealth: "ready",
      mcpHealth: "ready",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        registrationReady: true,
        runtimeActive: true,
        requiresFreshHostProcess: false,
        registration: {
          type: "stdio_broker",
          command: NODE_PATH,
          args: [BROKER_ENTRY_PATH],
          env: null,
          cwd: null,
        },
        checks: {
          registration: { status: "current", next: null },
          mcpHttpOwner: { status: "ready", url: MCP_URL, next: null },
          hostEnvironment: { status: "not_required", next: null },
        },
      },
    });
    expect(harness.io.stdout).not.toContain(MCP_TOKEN_ENV);
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
  });

  test("doctor reports an insecure credential as requiring explicit rotation", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "insecure",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        checks: {
          credential: {
            status: "insecure",
            next: expect.stringContaining("rotate-mcp-token"),
          },
        },
      },
    });
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
  });

  test("doctor reports an insecure Agent credential without mutating it", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      agentCredentialStatus: "insecure",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        registrationReady: false,
        checks: {
          agentCredential: {
            status: "insecure",
            next: expect.stringContaining("rotate-agent-token"),
          },
        },
      },
    });
    expect(harness.rotateAgentToken).not.toHaveBeenCalled();
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
  });

  test("doctor gives the explicit rotation path for an invalid Agent credential", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      agentCredentialStatus: "invalid",
    });

    expect(await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        registrationReady: false,
        checks: {
          agentCredential: {
            status: "invalid",
            next: expect.stringContaining("rotate-agent-token"),
          },
        },
      },
    });
    expect(harness.rotateAgentToken).not.toHaveBeenCalled();
  });

  test("start creates or validates the credential and ensures both detached owners", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(harness.loadOrCreateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledWith(MCP_TOKEN);
    expect(harness.acquireBridgeProfileLock).toHaveBeenCalledTimes(1);
    expect(harness.releaseBridgeProfileLock).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-start",
      data: {
        runtimeActive: true,
        browserOrigin: "http://127.0.0.1:38471",
        mcpHttpUrl: MCP_URL,
      },
    });
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
  });

  test("start retries one transient MCP owner startup after rechecking the browser owner", async () => {
    const harness = createHarness();
    harness.ensureMcpHttpOwner
      .mockRejectedValueOnce(new Error("mcp owner still starting"))
      .mockResolvedValueOnce(undefined);

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(0);

    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(2);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(2);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-start",
      data: { runtimeActive: true },
    });
  });

  test("start reports how to stop a legacy foreground HTTP server without killing it", async () => {
    const harness = createHarness({ mcpLegacyForeground: true });

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "MCP_HTTP_LEGACY_FOREGROUND_OWNER",
        next: expect.stringContaining("Stop the foreground meanthis mcp-http process"),
      },
    });
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test("start stops on an unverified listener with manual stop-port guidance", async () => {
    const harness = createHarness({ mcpUnverifiedListener: true });

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(5);

    const error = JSON.parse(harness.io.stderr).error;
    expect(error).toMatchObject({
      code: "MCP_HTTP_UNVERIFIED_LISTENER",
      next: UNVERIFIED_LISTENER_GUIDANCE,
    });
    expect(error.message).not.toContain("MeanThis");
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test("start requires explicit rotation instead of reusing an insecure credential", async () => {
    const harness = createHarness({ rotationRequired: true });

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "MCP_HTTP_CREDENTIAL_ROTATION_REQUIRED",
        next: expect.stringContaining("rotate-mcp-token"),
      },
    });
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("start requires explicit Agent credential rotation without touching host state", async () => {
    const harness = createHarness({ agentRotationRequired: true });

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED",
        next: expect.stringContaining("rotate-agent-token"),
      },
    });
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test("dry-run previews broker migration with zero credential, owner, backup, or config mutation", async () => {
    const harness = createHarness({ registration: createManagedMainStdioRegistration("meanthis") });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "migrate",
        changed: false,
        dryRun: true,
        replacedLegacyRegistration: false,
        planned: { replaceLegacyRegistration: true },
        registration: {
          type: "stdio_broker",
          command: NODE_PATH,
          args: [BROKER_ENTRY_PATH],
          env: null,
          cwd: null,
        },
      },
    });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
    expect(harness.acquireBridgeProfileLock).not.toHaveBeenCalled();
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("installs the exact thin stdio broker registration and starts both owners", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp",
      "add",
      "meanthis",
      "--",
      NODE_PATH,
      BROKER_ENTRY_PATH,
    ]);
    expect(harness.loadOrCreateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledWith(MCP_TOKEN);
    expect(harness.acquireBridgeProfileLock).toHaveBeenCalledTimes(1);
    expect(harness.releaseBridgeProfileLock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "add",
        changed: true,
        runtimeActive: true,
        requiresFreshHostProcess: true,
      },
    });
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
  });

  test("fails closed without rollback when broker install termination is unconfirmed", async () => {
    const harness = createHarness({ primaryAddTerminationUnconfirmed: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "CODEX_PROCESS_TERMINATION_UNCONFIRMED",
        process: {
          terminationStatus: "termination_unconfirmed",
          terminationReason: "timeout",
        },
        recovery: {
          status: "manual_required",
          outcomes: [{
            registrationName: "meanthis",
            status: "manual_required",
            reason: "termination_unconfirmed",
          }],
        },
      },
    });
    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(harness.releaseBridgeProfileLock).toHaveBeenCalledTimes(1);
  });

  test("requires explicit token rotation before reusing an installed broker registration", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      rotationRequired: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "MCP_HTTP_CREDENTIAL_ROTATION_REQUIRED",
        next: expect.stringContaining("rotate-mcp-token"),
      },
    });
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("migrates only exact managed stdio registrations", async () => {
    const harness = createHarness({
      registration: createManagedMainStdioRegistration("meanthis"),
      legacyRegistration: createManagedMainStdioRegistration("ui-attach"),
      resolverRegistration: createManagedResolverStdioRegistration(),
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(harness.runCodex).toHaveBeenCalledWith(["mcp", "remove", "ui-attach"]);
    expect(harness.runCodex).toHaveBeenCalledWith(["mcp", "remove", "meanthis-source-resolver"]);
    expect(harness.runCodex).toHaveBeenCalledWith(expect.arrayContaining([
      "mcp", "add", "meanthis", "--", NODE_PATH, BROKER_ENTRY_PATH,
    ]));
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "migrate",
        replacedLegacyRegistration: true,
        removedLegacyRegistration: true,
        removedStandaloneResolverRegistration: true,
      },
    });
  });

  test("migrates the exact former HTTP bearer-env registration to the broker", async () => {
    const harness = createHarness({ registration: createHttpRegistration() });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.getRegistration()).toEqual(createBrokerRegistration());
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp",
      "add",
      "meanthis",
      "--",
      NODE_PATH,
      BROKER_ENTRY_PATH,
    ]);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: { action: "migrate", replacedLegacyRegistration: true },
    });
  });

  test("accepts Codex 0.147 managed stdio readback when auth_status is absent", async () => {
    const harness = createHarness({
      registration: withoutAuthStatus(createManagedMainStdioRegistration("meanthis")),
      resolverRegistration: withoutAuthStatus(createManagedResolverStdioRegistration()),
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "migrate",
        planned: {
          replaceLegacyRegistration: true,
          removeStandaloneResolverRegistration: true,
        },
      },
    });
  });

  test("accepts an exact broker post-readback when Codex 0.147 omits auth_status", async () => {
    const harness = createHarness({ brokerReadbackOmitsAuthStatus: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.getRegistration()).toEqual(withoutAuthStatus(createBrokerRegistration()));
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: { action: "add", changed: true, runtimeActive: true },
    });
  });

  test.each([
    ["HTTP", { ...createHttpRegistration(), auth_status: "unsupported" }],
    ["HTTP null", { ...createHttpRegistration(), auth_status: null }],
    ["broker", { ...createBrokerRegistration(), auth_status: "bearer_token" }],
    ["legacy stdio", {
      ...createManagedMainStdioRegistration("meanthis"),
      auth_status: "bearer_token",
    }],
    ["resolver stdio", {
      ...createManagedResolverStdioRegistration(),
      auth_status: "bearer_token",
    }],
  ])("fails closed on a present incompatible auth_status for %s", async (kind, registration) => {
    const harness = kind === "resolver stdio"
      ? createHarness({ resolverRegistration: registration })
      : createHarness({ registration });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.io.stderr).not.toContain("bearer_token");
  });

  test("continues to accept present expected auth_status from older Codex broker readback", async () => {
    const harness = createHarness({ registration: createBrokerRegistration() });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({ data: { action: "none" } });
  });

  test("fails closed on a drifted standalone resolver before any side effect", async () => {
    const harness = createHarness({
      resolverRegistration: createManagedResolverStdioRegistration("C:\\other\\resolver\\cli.js"),
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({ error: { code: "REGISTRATION_CONFLICT" } });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(harness.io.stderr).not.toContain("C:\\other");
  });

  test.each([
    ["broker command", () => {
      const broker = createBrokerRegistration();
      return {
        ...broker,
        transport: {
          ...broker.transport,
          command: relative(process.cwd(), NODE_PATH),
        },
      };
    }],
    ["broker entry argument", () => {
      const broker = createBrokerRegistration();
      return {
        ...broker,
        transport: {
          ...broker.transport,
          args: [relative(process.cwd(), BROKER_ENTRY_PATH)],
        },
      };
    }],
  ])("rejects a relative %s even when it resolves to the managed path", async (
    _label,
    createRegistration,
  ) => {
    const harness = createHarness({ registration: createRegistration() });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
  });

  test("rejects a relative standalone resolver path instead of deleting it", async () => {
    const entryPath = relative(process.cwd(), RESOLVER_ENTRY_PATH);
    const harness = createHarness({
      resolverRegistration: {
        ...createManagedResolverStdioRegistration(),
        transport: {
          ...createManagedResolverStdioRegistration().transport,
          args: [entryPath],
        },
      },
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.runCodex).not.toHaveBeenCalledWith([
      "mcp",
      "remove",
      "meanthis-source-resolver",
    ]);
  });

  test.each([
    ["timeout", { startup_timeout_sec: 15 }],
    ["tool timeout", { tool_timeout_sec: 45 }],
    ["tool filter", { enabled_tools: ["meanthis_list_captures"] }],
    ["disabled tool filter", { disabled_tools: ["meanthis_read_capture"] }],
    ["disabled state", { enabled: false, disabled_reason: "fixture policy" }],
    ["unknown field", { future_codex_field: "custom" }],
  ])("refuses to uninstall a customized HTTP registration with %s", async (_label, customization) => {
    const harness = createHarness({
      registration: { ...createHttpRegistration(), ...customization },
    });

    expect(await runBridgeCli(
      ["uninstall", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
  });

  test("refuses to migrate a customized legacy stdio registration", async () => {
    const harness = createHarness({
      registration: {
        ...createManagedMainStdioRegistration("meanthis"),
        disabled_tools: ["meanthis_read_capture"],
      },
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test.each([
    ["extra arg", { args: [BROKER_ENTRY_PATH, "unexpected"] }],
    ["credential env", { env: { [MCP_TOKEN_ENV]: "redacted" } }],
    ["cwd", { cwd: resolve("fixtures", "foreign cwd") }],
    ["unknown transport field", { future_transport_field: true }],
  ])("rejects a broker registration with %s", async (_label, transportChange) => {
    const broker = createBrokerRegistration();
    const harness = createHarness({
      registration: {
        ...broker,
        transport: { ...broker.transport, ...transportChange },
      },
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.io.stderr).not.toContain("redacted");
  });

  test("rejects an HTTP registration with a different bearer env or direct headers", async () => {
    const registration = {
      ...createHttpRegistration(),
      transport: {
        ...createHttpRegistration().transport,
        bearer_token_env_var: "OTHER_TOKEN",
        http_headers: { authorization: "redacted-but-unmanaged" },
      },
    };
    const harness = createHarness({ registration });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({ error: { code: "REGISTRATION_CONFLICT" } });
    expect(harness.io.stderr).not.toContain("redacted-but-unmanaged");
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
  });

  test("fails before creating credentials when the Codex config backup fails", async () => {
    const harness = createHarness({ backupError: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({ error: { code: "CONFIG_BACKUP_FAILED" } });
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
  });

  test("does not mutate Codex config when credential preparation fails", async () => {
    const harness = createHarness({ tokenError: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "MCP_HTTP_CREDENTIAL_FAILED" },
    });
    expect(harness.backupCodexConfig).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("does not mutate Codex config when either owner cannot start", async () => {
    const harness = createHarness({ mcpOwnerError: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({ error: { code: "BRIDGE_START_FAILED" } });
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(2);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(2);
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("does not mutate Codex config while a legacy foreground HTTP server owns the port", async () => {
    const harness = createHarness({ mcpLegacyForeground: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "MCP_HTTP_LEGACY_FOREGROUND_OWNER",
        next: expect.stringContaining("Stop the foreground meanthis mcp-http process"),
      },
    });
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("does not mutate Codex config while an unverified listener owns the port", async () => {
    const harness = createHarness({ mcpUnverifiedListener: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    const error = JSON.parse(harness.io.stderr).error;
    expect(error).toMatchObject({
      code: "MCP_HTTP_UNVERIFIED_LISTENER",
      next: UNVERIFIED_LISTENER_GUIDANCE,
    });
    expect(error.message).not.toContain("MeanThis");
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("restores the exact managed stdio registration when broker add fails after replacing it", async () => {
    const harness = createHarness({
      registration: createManagedMainStdioRegistration("meanthis"),
      primaryAddFailure: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp", "add", "meanthis", "--", NODE_PATH, ENTRY_PATH, "mcp",
    ]);
    expect(harness.getRegistration()).toEqual(createManagedMainStdioRegistration("meanthis"));
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_WRITE_FAILED",
        recovery: {
          status: "restored",
          configBackup: { status: "created", path: expect.any(String) },
        },
      },
    });
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("restores the exact managed stdio registration when broker readback fails", async () => {
    const harness = createHarness({
      registration: createManagedMainStdioRegistration("meanthis"),
      legacyRegistration: createManagedMainStdioRegistration("ui-attach"),
      resolverRegistration: createManagedResolverStdioRegistration(),
      primaryVerificationFailure: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_VERIFY_FAILED",
        recovery: {
          status: "restored",
          configBackup: { status: "created", path: expect.any(String) },
        },
      },
    });
    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp", "add", "meanthis", "--", NODE_PATH, ENTRY_PATH, "mcp",
    ]);
    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "ui-attach"]);
    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis-source-resolver"]);
    expect(harness.getRegistration()).toEqual(createManagedMainStdioRegistration("meanthis"));
  });

  test("rolls back earlier managed changes when a later legacy removal partially fails", async () => {
    const harness = createHarness({
      registration: createManagedMainStdioRegistration("meanthis"),
      legacyRegistration: createManagedMainStdioRegistration("ui-attach"),
      resolverRegistration: createManagedResolverStdioRegistration(),
      resolverRemoveFailure: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { recovery: { status: "restored" } },
    });
    expect(harness.getRegistration()).toEqual(createManagedMainStdioRegistration("meanthis"));
    expect(harness.getLegacyRegistration()).toEqual(createManagedMainStdioRegistration("ui-attach"));
    expect(harness.getResolverRegistration()).toEqual(createManagedResolverStdioRegistration());
  });

  test("restores the exact former HTTP registration when broker add fails", async () => {
    const harness = createHarness({
      registration: createHttpRegistration(),
      primaryAddFailure: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp", "add", "meanthis", "--url", MCP_URL,
      "--bearer-token-env-var", MCP_TOKEN_ENV,
    ]);
    expect(harness.getRegistration()).toEqual(createHttpRegistration());
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_WRITE_FAILED", recovery: { status: "restored" } },
    });
  });

  test.each([
    [
      "HTTP registration with a managed stdio registration",
      createHttpRegistration(),
      createManagedMainStdioRegistration("meanthis"),
    ],
    [
      "managed stdio registration with an HTTP registration",
      createManagedMainStdioRegistration("meanthis"),
      createHttpRegistration(),
    ],
  ])("does not report rollback restored when an external writer replaces the %s", async (
    _label,
    initialRegistration,
    externalRegistration,
  ) => {
    const harness = createHarness({
      registration: initialRegistration,
      primaryAddFailure: true,
      primaryRegistrationOnRead: { count: 4, value: externalRegistration },
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.getRegistration()).toEqual(externalRegistration);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_WRITE_FAILED",
        recovery: {
          status: "manual_required",
          outcomes: [{ registrationName: "meanthis", status: "manual_required" }],
        },
      },
    });
  });

  test("marks rollback manual when the restore process tree cannot be confirmed terminated", async () => {
    const harness = createHarness({
      registration: createHttpRegistration(),
      primaryAddFailure: true,
      httpRestoreTerminationUnconfirmed: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_WRITE_FAILED",
        recovery: {
          status: "manual_required",
          outcomes: [{
            registrationName: "meanthis",
            status: "manual_required",
            reason: "termination_unconfirmed",
          }],
        },
      },
    });
  });

  test("reports committed-but-unverified when the final aggregate registration readback changes", async () => {
    const harness = createHarness({ replacePrimaryOnRead: 4 });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_COMMITTED_BUT_UNVERIFIED",
        commit: { status: "committed_but_unverified" },
        recovery: { status: "manual_required" },
      },
    });
    expect(harness.io.stderr).not.toContain("foreign-secret");
  });

  test("continues best-effort rollback after one restore fails", async () => {
    const harness = createHarness({
      registration: createManagedMainStdioRegistration("meanthis"),
      legacyRegistration: createManagedMainStdioRegistration("ui-attach"),
      resolverRegistration: createManagedResolverStdioRegistration(),
      resolverRemoveFailure: true,
      resolverRestoreFailure: true,
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        recovery: {
          status: "manual_required",
          outcomes: [
            { registrationName: "meanthis-source-resolver", status: "manual_required" },
            { registrationName: "ui-attach", status: "restored" },
            { registrationName: "meanthis", status: "restored" },
          ],
        },
      },
    });
    expect(harness.getRegistration()).toEqual(createManagedMainStdioRegistration("meanthis"));
    expect(harness.getLegacyRegistration()).toEqual(createManagedMainStdioRegistration("ui-attach"));
    expect(harness.getResolverRegistration()).toBeNull();
  });

  test("is idempotent for the exact broker registration while still ensuring runtime owners", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
    });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledWith(MCP_TOKEN);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "none",
        changed: false,
        runtimeActive: true,
        requiresFreshHostProcess: true,
      },
    });
  });

  test("uninstall removes only the exact broker registration and preserves the credential", async () => {
    const harness = createHarness({ registration: createBrokerRegistration() });

    expect(await runBridgeCli(
      ["uninstall", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.runCodex).toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(harness.rotateMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-uninstall",
      data: { action: "remove", changed: true },
    });
  });

  test("uninstall fails closed when the registration is replaced before the destructive readback", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      replacePrimaryOnRead: 2,
    });

    expect(await runBridgeCli(
      ["uninstall", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.runCodex).not.toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_CONFLICT",
        recovery: {
          status: "not_required",
          configBackup: { status: "created", path: expect.any(String) },
        },
      },
    });
    expect(harness.io.stderr).not.toContain("foreign-secret");
  });

  test("uninstall restores the exact broker registration after a partial remove failure", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      primaryRemoveFailure: true,
    });

    expect(await runBridgeCli(
      ["uninstall", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.runCodex).toHaveBeenCalledWith(["mcp", "remove", "meanthis"]);
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp", "add", "meanthis", "--", NODE_PATH, BROKER_ENTRY_PATH,
    ]);
    expect(harness.getRegistration()).toEqual(createBrokerRegistration());
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "REGISTRATION_WRITE_FAILED",
        recovery: { status: "restored" },
      },
    });
  });

  test("fails before config mutation when the profile-scoped setup lock is unavailable", async () => {
    const harness = createHarness({ configLockError: true });

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "PROFILE_LOCK_UNAVAILABLE", next: expect.any(String) },
    });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.loadOrCreateMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test("does not report success when the profile lock cannot be released", async () => {
    const harness = createHarness({ configLockReleaseError: true });

    expect(await runBridgeCli(["start", "--json"], harness.io, harness.dependencies)).toBe(5);

    expect(harness.io.stdout).toBe("");
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "PROFILE_LOCK_RELEASE_FAILED" },
    });
  });

  test("serializes start against token rotation across credential and owner transition", async () => {
    const ownerGate = deferred<void>();
    const harness = createHarness({
      registration: createBrokerRegistration(),
      serializeProfileLock: true,
      ownerGate: ownerGate.promise,
    });
    const startIo = createTestIo();
    const rotateIo = createTestIo();

    const start = runBridgeCli(["start", "--json"], startIo, harness.dependencies);
    await vi.waitFor(() => expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(1));
    const rotate = runBridgeCli(
      ["rotate-mcp-token", "--host", "codex", "--json"],
      rotateIo,
      harness.dependencies,
    );
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    expect(harness.rotateMcpHttpToken).not.toHaveBeenCalled();

    ownerGate.resolve();
    expect(await start).toBe(0);
    expect(await rotate).toBe(0);
    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
  });

  test("serializes install against token rotation", async () => {
    const ownerGate = deferred<void>();
    const harness = createHarness({
      registration: createBrokerRegistration(),
      serializeProfileLock: true,
      ownerGate: ownerGate.promise,
    });
    const installIo = createTestIo();
    const rotateIo = createTestIo();

    const install = runBridgeCli(
      ["install", "--host", "codex", "--json"],
      installIo,
      harness.dependencies,
    );
    await vi.waitFor(() => expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(1));
    const rotate = runBridgeCli(
      ["rotate-mcp-token", "--host", "codex", "--json"],
      rotateIo,
      harness.dependencies,
    );
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    expect(harness.rotateMcpHttpToken).not.toHaveBeenCalled();

    ownerGate.resolve();
    expect(await install).toBe(0);
    expect(await rotate).toBe(0);
  });

  test("uninstall refuses even an exact legacy stdio registration", async () => {
    const harness = createHarness({ registration: createManagedMainStdioRegistration("meanthis") });

    expect(await runBridgeCli(
      ["uninstall", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({ error: { code: "REGISTRATION_CONFLICT" } });
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]));
  });

  test("launch is a fail-safe deprecation that never reads credentials or starts a process", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      browserHealth: "ready",
      mcpHealth: "ready",
    });

    expect(await runBridgeCli(
      ["launch", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(2);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "HOST_LAUNCH_UNSUPPORTED",
        next: "Run meanthis bridge start --json, then restart the Codex host or open a fresh task.",
      },
    });
    expect(harness.runCodex).not.toHaveBeenCalled();
    expect(harness.inspectMcpHttpCredential).not.toHaveBeenCalled();
    expect(harness.readMcpHttpToken).not.toHaveBeenCalled();
    expect(harness.acquireBridgeProfileLock).not.toHaveBeenCalled();
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("rotates the MCP credential, restarts owners, and requires task restart without printing it", async () => {
    const harness = createHarness({ registration: createBrokerRegistration() });

    expect(await runBridgeCli(
      ["rotate-mcp-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledWith(MCP_TOKEN);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-mcp-token-rotated",
      data: {
        rotated: true,
        runtimeActive: true,
        requiresFreshHostProcess: true,
        next: "Restart affected Codex tasks or the Codex host before using MeanThis again.",
      },
    });
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
  });

  test("rotates both credentials for Agent-key recovery and verifies both owners", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      credentialStatus: "ready",
      agentCredentialStatus: "insecure",
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateMcpHttpToken.mock.invocationCallOrder[0]).toBeLessThan(
      harness.rotateAgentToken.mock.invocationCallOrder[0],
    );
    expect(harness.acquireBridgeProfileLock).toHaveBeenCalledTimes(1);
    expect(harness.releaseBridgeProfileLock).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledWith(AGENT_TOKEN);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledWith(MCP_TOKEN);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-agent-token-rotated",
      data: {
        agentCredentialRotated: true,
        mcpHttpCredentialRotated: true,
        runtimeActive: true,
        requiresFreshHostProcess: true,
      },
    });
    expect(harness.io.stdout).not.toContain(AGENT_TOKEN);
    expect(harness.io.stdout).not.toContain(MCP_TOKEN);
  });

  test.each([
    ["missing", null],
    ["legacy", createManagedMainStdioRegistration("meanthis")],
  ] as const)(
    "rotates both credentials and turns over the browser owner before install when registration is %s",
    async (registrationStatus, registration) => {
      const harness = createHarness({
        agentCredentialStatus: "insecure",
        registration,
      });

      expect(await runBridgeCli(
        ["rotate-agent-token", "--host", "codex", "--json"],
        harness.io,
        harness.dependencies,
      )).toBe(0);

      expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
      expect(harness.rotateAgentToken).toHaveBeenCalledTimes(1);
      expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
      expect(harness.ensureBrowserOwner).toHaveBeenCalledWith(AGENT_TOKEN);
      expect(harness.rotateAgentToken.mock.invocationCallOrder[0]).toBeLessThan(
        harness.ensureBrowserOwner.mock.invocationCallOrder[0],
      );
      expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
      expect(JSON.parse(harness.io.stdout)).toMatchObject({
        data: {
          browserOwnerActive: true,
          runtimeActive: false,
          registrationStatus,
          next: "Run meanthis bridge install --host codex --json.",
        },
      });
      expect(harness.io.stdout).not.toContain(AGENT_TOKEN);
      expect(harness.io.stdout).not.toContain(MCP_TOKEN);
    },
  );

  test("fails honestly if the browser owner cannot turn over after pre-install rotation", async () => {
    const harness = createHarness({
      agentCredentialStatus: "insecure",
      browserOwnerError: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_START_FAILED",
        message: expect.stringContaining("browser owner did not turn over"),
        partialState: {
          credentialRotation: "committed_and_initially_verified",
          browserOwner: "turnover_unverified",
          mcpHttpOwner: "not_started",
        },
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("fails closed if the Agent credential changes during pre-install owner turnover", async () => {
    const harness = createHarness({ agentCredentialDriftsAfterOwnerEnsure: true });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
        partialState: {
          credentialRotation: "committed_final_verification_failed",
          browserOwner: {
            turnover: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "unverified",
          },
          mcpHttpOwner: "not_started",
        },
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(DRIFTED_AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("fails closed if an external writer replaces registration during pre-install rotation", async () => {
    const harness = createHarness({ replacePrimaryOnRead: 2 });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
        partialState: {
          credentialRotation: "committed_final_verification_failed",
          browserOwner: {
            turnover: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "unverified",
          },
          mcpHttpOwner: "not_started",
        },
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("reports an unconfirmed final registration process after pre-install rotation", async () => {
    const harness = createHarness({ primaryReadTerminationUnconfirmedAt: 2 });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "CODEX_PROCESS_TERMINATION_UNCONFIRMED",
        process: { terminationStatus: "termination_unconfirmed" },
        partialState: {
          credentialRotation: "committed_and_initially_verified",
          browserOwner: {
            turnover: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "process_termination_unconfirmed",
          },
          mcpHttpOwner: "not_started",
        },
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("reports bounded owner-drain state if final verification fails after current-runtime turnover", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      agentCredentialDriftsAfterOwnerEnsure: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.ensureBrowserOwner).toHaveBeenCalledTimes(1);
    expect(harness.ensureMcpHttpOwner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
        partialState: {
          credentialRotation: "committed_final_verification_failed",
          browserOwner: {
            startOrReuse: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "unverified",
          },
          mcpHttpOwner: {
            startOrReuse: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "unverified",
          },
        },
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(DRIFTED_AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("pins owner turnover to the rotated Agent token and rejects a colliding diagnostic readback", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      agentCredentialDriftsBeforeOwnerEnsure: true,
      spoofAgentInspectionFingerprint: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.ensureBrowserOwner).toHaveBeenCalledWith(AGENT_TOKEN);
    expect(harness.readAgentToken).toHaveBeenCalled();
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
        partialState: {
          credentialRotation: "committed_final_verification_failed",
        },
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(DRIFTED_AGENT_TOKEN);
  });

  test("reports partial credential rotation honestly when Agent rotation fails", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      agentTokenError: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).toHaveBeenCalledTimes(1);
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_AGENT_CREDENTIAL_ROTATION_FAILED",
        next: expect.stringContaining("rotate-agent-token"),
      },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("does not rotate the Agent credential when MCP rotation fails before commit", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      tokenRotationError: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "MCP_HTTP_CREDENTIAL_FAILED" },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("does not rotate the Agent credential after an unverified MCP rotation commit", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      tokenRotationCommittedButUnverified: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(harness.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
    expect(harness.rotateAgentToken).not.toHaveBeenCalled();
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED" },
    });
    expect(harness.io.stderr).not.toContain(AGENT_TOKEN);
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test("reports committed-but-unverified Agent rotation without claiming rollback", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      agentTokenRotationCommittedButUnverified: true,
    });

    expect(await runBridgeCli(
      ["rotate-agent-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "BRIDGE_AGENT_CREDENTIAL_ROTATION_UNVERIFIED",
        next: expect.stringContaining("doctor"),
      },
    });
    expect(harness.io.stderr).not.toContain("was not rotated");
  });

  test.each([
    ["missing", null],
    ["legacy", createManagedMainStdioRegistration("meanthis")],
    ["legacy", createHttpRegistration()],
  ] as const)(
    "allows explicit secure rotation before install when registration is %s",
    async (registrationStatus, registration) => {
      const harness = createHarness({ registration });

      expect(await runBridgeCli(
        ["rotate-mcp-token", "--host", "codex", "--json"],
        harness.io,
        harness.dependencies,
      )).toBe(0);

      expect(JSON.parse(harness.io.stdout)).toMatchObject({
        data: {
          rotated: true,
          runtimeActive: false,
          registrationStatus,
          requiresFreshHostProcess: true,
          next: "Run meanthis bridge install --host codex --json.",
        },
      });
      expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
      expect(harness.ensureMcpHttpOwner).not.toHaveBeenCalled();
      expect(harness.io.stdout).not.toContain(MCP_TOKEN);
    },
  );

  test("refuses token rotation for a drifted registration", async () => {
    const harness = createHarness({ registration: createForeignHttpRegistration() });

    expect(await runBridgeCli(
      ["rotate-mcp-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_NOT_READY" },
    });
    expect(harness.rotateMcpHttpToken).not.toHaveBeenCalled();
  });

  test("reports a committed but unverified token rotation without claiming it did not rotate", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      tokenRotationCommittedButUnverified: true,
    });

    expect(await runBridgeCli(
      ["rotate-mcp-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED",
        next: expect.stringContaining("bridge doctor"),
      },
    });
    expect(harness.ensureBrowserOwner).not.toHaveBeenCalled();
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
    expect(harness.io.stderr).not.toContain("was not rotated");
  });

  test("verifies the live credential after rotation before reporting success", async () => {
    const harness = createHarness({
      registration: createBrokerRegistration(),
      rotationFinalTokenMismatch: true,
    });

    expect(await runBridgeCli(
      ["rotate-mcp-token", "--host", "codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: {
        code: "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED",
        next: expect.stringContaining("bridge doctor"),
      },
    });
    expect(harness.io.stderr).not.toContain(MCP_TOKEN);
  });

  test.each([
    ["install", "claude-code"],
    ["uninstall", "cursor"],
  ] as const)("does not pretend to automate %s for %s", async (command, host) => {
    const harness = createHarness();
    expect(await runBridgeCli(
      [command, "--host", host, "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "HOST_INSTALL_NOT_AUTOMATED" },
    });
  });
});

describe("MeanThis bridge profile lock", () => {
  const lockFile = ".meanthis-bridge-profile.lock";
  const reclaimFile = ".meanthis-bridge-profile.reclaim.lock";
  const ttlMs = 60_000;
  const ownProcessInstanceId = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
  const otherProcessInstanceId = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
  const identityOptions = {
    processInstanceId: ownProcessInstanceId,
    readProcessInstanceId: async () => ownProcessInstanceId,
  };

  test("acquires and releases with the platform process-instance identity reader", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-platform-identity-"));
    try {
      const release = await acquireMeanThisBridgeProfileLock({ codexHome, ttlMs });
      await release();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  }, 10_000);

  test("fails closed while another live lock owns the profile", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-active-"));
    try {
      const release = await acquireMeanThisBridgeProfileLock({ codexHome, ttlMs, ...identityOptions });
      await expect(acquireMeanThisBridgeProfileLock({
        codexHome,
        ttlMs,
        ...identityOptions,
      })).rejects.toMatchObject({
        status: "active",
      });
      await release();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("does not steal an expired record while its owning process is still alive", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-live-expired-"));
    const now = Date.now();
    try {
      await writeFile(join(codexHome, lockFile), `${JSON.stringify({
        kind: "meanthis-bridge-profile-lock-v1",
        pid: 900_003,
        nonce: "CCCCCCCCCCCCCCCCCCCCCC",
        processInstanceId: ownProcessInstanceId,
        createdAt: new Date(now - ttlMs - 2_000).toISOString(),
        expiresAt: new Date(now - 1_000).toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600 });

      await expect(acquireMeanThisBridgeProfileLock({
        codexHome,
        now: () => now,
        ttlMs,
        isProcessAlive: (pid) => pid === 900_003,
        ...identityOptions,
      })).rejects.toMatchObject({ status: "active" });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("reclaims a valid record when the PID belongs to a different process instance", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-pid-reused-"));
    const now = Date.now();
    try {
      await writeFile(join(codexHome, lockFile), `${JSON.stringify({
        kind: "meanthis-bridge-profile-lock-v1",
        pid: 900_004,
        nonce: "FFFFFFFFFFFFFFFFFFFFFF",
        processInstanceId: ownProcessInstanceId,
        createdAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600 });

      const release = await acquireMeanThisBridgeProfileLock({
        codexHome,
        now: () => now,
        ttlMs,
        isProcessAlive: (pid) => pid === 900_004,
        processInstanceId: otherProcessInstanceId,
        readProcessInstanceId: async () => otherProcessInstanceId,
      });
      await release();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("keeps a truncated lock fail-closed until TTL then safely reclaims it", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-truncated-"));
    const now = Date.now();
    const lockPath = join(codexHome, lockFile);
    try {
      await writeFile(lockPath, "{", { encoding: "utf8", mode: 0o600 });
      await expect(acquireMeanThisBridgeProfileLock({
        codexHome,
        now: () => now,
        ttlMs,
        ...identityOptions,
      })).rejects.toMatchObject({ status: "invalid" });

      const reclaimNow = Date.now() + ttlMs + 2_000;
      const old = new Date(now - ttlMs - 1_000);
      await utimes(lockPath, old, old);
      const release = await acquireMeanThisBridgeProfileLock({
        codexHome,
        now: () => reclaimNow,
        ttlMs,
        ...identityOptions,
      });
      await release();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("recovers an abandoned reclaim guard before reclaiming an abandoned main lock", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-reclaim-"));
    const now = Date.now();
    const reclaimNow = now + ttlMs + 2_000;
    const old = new Date(now - ttlMs - 1_000);
    try {
      await writeFile(join(codexHome, lockFile), "{", { encoding: "utf8", mode: 0o600 });
      await writeFile(join(codexHome, reclaimFile), "{", { encoding: "utf8", mode: 0o600 });
      await utimes(join(codexHome, lockFile), old, old);
      await utimes(join(codexHome, reclaimFile), old, old);

      const release = await acquireMeanThisBridgeProfileLock({
        codexHome,
        now: () => reclaimNow,
        ttlMs,
        ...identityOptions,
      });
      await release();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("reclaims valid locks whose process is gone, including an abandoned reclaim guard", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-dead-owner-"));
    const now = Date.now();
    const record = (
      pid: number,
      nonce: string,
      createdAt: number,
      expiresAt: number,
    ) => ({
      kind: "meanthis-bridge-profile-lock-v1",
      pid,
      nonce,
      processInstanceId: ownProcessInstanceId,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    try {
      await writeFile(join(codexHome, lockFile), `${JSON.stringify(record(
        900_001,
        "AAAAAAAAAAAAAAAAAAAAAA",
        now - 1_000,
        now + ttlMs,
      ))}\n`, { encoding: "utf8", mode: 0o600 });
      await writeFile(join(codexHome, reclaimFile), `${JSON.stringify(record(
        900_002,
        "BBBBBBBBBBBBBBBBBBBBBB",
        now - ttlMs - 2_000,
        now - 1_000,
      ))}\n`, { encoding: "utf8", mode: 0o600 });

      const release = await acquireMeanThisBridgeProfileLock({
        codexHome,
        now: () => now,
        ttlMs,
        isProcessAlive: () => false,
        ...identityOptions,
      });
      await release();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("never reclaims a directory or symbolic link as a lock file", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-lock-unsafe-"));
    const target = join(codexHome, "target");
    try {
      await mkdir(join(codexHome, lockFile));
      await expect(acquireMeanThisBridgeProfileLock({
        codexHome,
        ttlMs,
        ...identityOptions,
      })).rejects.toBeInstanceOf(
        MeanThisBridgeProfileLockError,
      );
      await rm(join(codexHome, lockFile), { recursive: true, force: true });
      await writeFile(target, "not a lock", "utf8");
      try {
        await symlink(target, join(codexHome, lockFile), "file");
        await expect(acquireMeanThisBridgeProfileLock({
          codexHome,
          ttlMs,
          ...identityOptions,
        })).rejects.toMatchObject({
          status: "invalid",
        });
      } catch (error) {
        if (!(error instanceof Error) || !["EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )) throw error;
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("Codex config backup permissions", () => {
  test.runIf(process.platform !== "win32")(
    "applies and verifies owner-only mode on Unix backups",
    async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanthis-backup-mode-"));
    const path = join(directory, "config.toml.bak");
    try {
      await writeFile(path, "secret = 'fixture'\n", { encoding: "utf8", mode: 0o644 });
      await secureCodexConfigBackup(path, { platform: "linux" });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    },
  );

  test("requires the protected Windows ACL application before accepting a backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanthis-backup-acl-"));
    const path = join(directory, "config.toml.bak");
    const applyWindowsAcl = vi.fn(async () => undefined);
    const lowerCaseTokenName = MCP_TOKEN_ENV.toLowerCase();
    const environment: NodeJS.ProcessEnv = {
      [lowerCaseTokenName]: MCP_TOKEN,
      MEANTHIS_UNRELATED: "preserved",
    };
    try {
      await writeFile(path, "secret = 'fixture'\n", "utf8");
      await secureCodexConfigBackup(path, { platform: "win32", applyWindowsAcl, environment });
      expect(applyWindowsAcl).toHaveBeenCalledWith(path, {
        MEANTHIS_UNRELATED: "preserved",
      });
      expect(environment).toEqual({
        [lowerCaseTokenName]: MCP_TOKEN,
        MEANTHIS_UNRELATED: "preserved",
      });
      await expect(secureCodexConfigBackup(path, {
        platform: "win32",
        applyWindowsAcl: async () => { throw new Error("ACL failed"); },
      })).rejects.toThrow("ACL failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("bounded Codex process-tree termination", () => {
  test("removes ambient bearer keys case-insensitively from child process environments", async () => {
    const child = createFakeRunProcessChild(42_099);
    const lowerCaseTokenName = MCP_TOKEN_ENV.toLowerCase();
    const environment: NodeJS.ProcessEnv = {
      [lowerCaseTokenName]: MCP_TOKEN,
      MEANTHIS_UNRELATED: "preserved",
    };
    const spawnProcess = vi.fn((
      _executable: string,
      _args: string[],
      _options: RunProcessSpawnOptions,
    ) => child);
    const resultPromise = runProcess("codex", ["mcp", "list"], 1_000, {
      environment,
      spawnProcess,
    });

    child.emitClose(0);
    await expect(resultPromise).resolves.toMatchObject({ started: true, exitCode: 0 });
    expect(spawnProcess).toHaveBeenCalledWith(
      "codex",
      ["mcp", "list"],
      expect.objectContaining({
        env: { MEANTHIS_UNRELATED: "preserved" },
      }),
    );
    expect(environment).toEqual({
      [lowerCaseTokenName]: MCP_TOKEN,
      MEANTHIS_UNRELATED: "preserved",
    });
  });

  test("accepts a synchronous close while registering the close waiter", async () => {
    let exitCode: number | null = null;
    const child: RunProcessChild = {
      pid: 42_100,
      get exitCode() { return exitCode; },
      signalCode: null,
      onStdout() {},
      onStderr() {},
      onceError() {},
      onceClose(listener) {
        exitCode = 0;
        listener(0);
      },
    };

    await expect(waitForRunProcessChildClose(child, 100)).resolves.toBe(true);
  });

  test("does not resolve a timeout until exact-tree termination is confirmed", async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeRunProcessChild(42_101);
      let confirmTermination!: (confirmed: boolean) => void;
      const terminationGate = new Promise<boolean>((resolveTermination) => {
        confirmTermination = resolveTermination;
      });
      const terminateProcessTree = vi.fn(() => terminationGate);
      const spawnProcess = vi.fn((
        _executable: string,
        _args: string[],
        _options: RunProcessSpawnOptions,
      ) => child);
      const resultPromise = runProcess("codex", ["mcp", "add"], 25, {
        spawnProcess,
        terminateProcessTree,
        terminationTimeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(terminateProcessTree).toHaveBeenCalledWith(child, 100);
      expect(spawnProcess).toHaveBeenCalledWith(
        "codex",
        ["mcp", "add"],
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
      let settled = false;
      void resultPromise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      confirmTermination(true);
      await expect(resultPromise).resolves.toMatchObject({
        started: true,
        exitCode: null,
        terminationStatus: "confirmed",
        terminationReason: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("distinguishes an unconfirmed process tree after output overflow", async () => {
    const child = createFakeRunProcessChild(42_102);
    let confirmTermination!: (confirmed: boolean) => void;
    const terminationGate = new Promise<boolean>((resolveTermination) => {
      confirmTermination = resolveTermination;
    });
    const terminateProcessTree = vi.fn(() => terminationGate);
    const resultPromise = runProcess("codex", ["mcp", "get", "meanthis"], 1_000, {
      spawnProcess: () => child,
      terminateProcessTree,
      terminationTimeoutMs: 100,
    });

    child.emitStdout(Buffer.alloc(1_048_577, 0x61));
    expect(terminateProcessTree).toHaveBeenCalledWith(child, 100);
    let settled = false;
    void resultPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    confirmTermination(false);
    await expect(resultPromise).resolves.toMatchObject({
      started: true,
      exitCode: null,
      terminationStatus: "termination_unconfirmed",
      terminationReason: "output_limit",
    });
  });

  test("preserves normal close output without invoking tree termination", async () => {
    const child = createFakeRunProcessChild(42_103);
    const terminateProcessTree = vi.fn(async () => true);
    const resultPromise = runProcess("codex", ["mcp", "get", "meanthis"], 1_000, {
      spawnProcess: () => child,
      terminateProcessTree,
    });

    child.emitStdout(Buffer.from("ok\n"));
    child.emitStderr(Buffer.from("note\n"));
    child.emitClose(0);

    await expect(resultPromise).resolves.toEqual({
      started: true,
      exitCode: 0,
      stdout: "ok\n",
      stderr: "note\n",
    });
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  test("preserves a normal spawn error without invoking tree termination", async () => {
    const child = createFakeRunProcessChild(42_104);
    const terminateProcessTree = vi.fn(async () => true);
    const resultPromise = runProcess("codex", ["mcp", "list"], 1_000, {
      spawnProcess: () => child,
      terminateProcessTree,
    });

    child.emitError(new Error("spawn failed"));

    await expect(resultPromise).resolves.toEqual({
      started: false,
      exitCode: null,
      stdout: "",
      stderr: "",
    });
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });
});

type CredentialStatus = "ready" | "missing" | "invalid" | "insecure" | "unavailable";
type McpHealth =
  | "ready"
  | "not_running"
  | "stale_build"
  | "legacy_foreground"
  | "unverified_listener"
  | "unexpected";

interface HarnessOptions {
  registration?: unknown;
  legacyRegistration?: unknown;
  resolverRegistration?: unknown;
  browserHealth?: "ready" | "not_running" | "unexpected";
  mcpHealth?: McpHealth;
  credentialStatus?: CredentialStatus;
  agentCredentialStatus?: CredentialStatus;
  backupError?: boolean;
  browserOwnerError?: boolean;
  mcpOwnerError?: boolean;
  mcpLegacyForeground?: boolean;
  mcpUnverifiedListener?: boolean;
  agentRotationRequired?: boolean;
  agentTokenError?: boolean;
  agentTokenRotationCommittedButUnverified?: boolean;
  agentCredentialDriftsBeforeOwnerEnsure?: boolean;
  agentCredentialDriftsAfterOwnerEnsure?: boolean;
  spoofAgentInspectionFingerprint?: boolean;
  tokenError?: boolean;
  rotationRequired?: boolean;
  tokenRotationError?: boolean;
  tokenRotationCommittedButUnverified?: boolean;
  rotationFinalTokenMismatch?: boolean;
  configLockError?: boolean;
  configLockReleaseError?: boolean;
  primaryAddFailure?: boolean;
  primaryAddTerminationUnconfirmed?: boolean;
  primaryRemoveFailure?: boolean;
  primaryVerificationFailure?: boolean;
  primaryReadTerminationUnconfirmedAt?: number;
  replacePrimaryOnRead?: number;
  primaryRegistrationOnRead?: { count: number; value: unknown };
  resolverRemoveFailure?: boolean;
  resolverRestoreFailure?: boolean;
  httpRestoreTerminationUnconfirmed?: boolean;
  serializeProfileLock?: boolean;
  ownerGate?: Promise<void>;
  brokerReadbackOmitsAuthStatus?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  let registration = options.registration ?? null;
  let legacyRegistration = options.legacyRegistration ?? null;
  let resolverRegistration = options.resolverRegistration ?? null;
  let primaryReadCount = 0;
  let primaryVerificationFailurePending = options.primaryVerificationFailure ?? false;
  let credentialStatus = options.credentialStatus ?? "missing";
  let agentCredentialStatus = options.agentCredentialStatus ?? "ready";
  let mcpHealth = options.mcpHealth ?? "not_running";
  let storedToken = MCP_TOKEN;
  let storedAgentToken = AGENT_TOKEN;
  const io = createTestIo();
  const releaseBridgeProfileLock = vi.fn(async () => {
    if (options.configLockReleaseError) throw new Error("release failed");
  });
  let lockTail = Promise.resolve();
  const acquireBridgeProfileLock = vi.fn(async () => {
    if (options.configLockError) throw new Error("lock unavailable");
    if (!options.serializeProfileLock) return releaseBridgeProfileLock;
    const previous = lockTail;
    let unlock!: () => void;
    lockTail = new Promise<void>((resolveLock) => { unlock = resolveLock; });
    await previous;
    return async () => {
      try {
        await releaseBridgeProfileLock();
      } finally {
        unlock();
      }
    };
  });
  const backupCodexConfig = vi.fn(async () => {
    if (options.backupError) throw new Error("backup failed");
    return {
      status: "created" as const,
      path: "C:\\Users\\fixture-user\\.codex\\config.toml.bak-meanthis-test",
    };
  });
  const runCodex = vi.fn(async (args: string[]): Promise<CodexProcessResult> => {
    const key = args.join(" ");
    if (key === "mcp get meanthis --json") {
      primaryReadCount += 1;
      if (options.primaryReadTerminationUnconfirmedAt === primaryReadCount) {
        return terminationUnconfirmed("timeout");
      }
      if (options.replacePrimaryOnRead === primaryReadCount) {
        registration = createForeignHttpRegistration();
      }
      if (options.primaryRegistrationOnRead?.count === primaryReadCount) {
        registration = options.primaryRegistrationOnRead.value;
      }
      return registrationResult("meanthis", registration);
    }
    if (key === "mcp get ui-attach --json") return registrationResult("ui-attach", legacyRegistration);
    if (key === "mcp get meanthis-source-resolver --json") {
      return registrationResult("meanthis-source-resolver", resolverRegistration);
    }
    if (args.slice(0, 3).join(" ") === "mcp add meanthis" && args.includes("--url")) {
      registration = createHttpRegistration();
      if (options.httpRestoreTerminationUnconfirmed) {
        return terminationUnconfirmed("timeout");
      }
      return success("Restored global MCP server 'meanthis'.");
    }
    if (args.slice(0, 3).join(" ") === "mcp add meanthis") {
      const separatorIndex = args.indexOf("--");
      const command = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
      const isBroker = command.length === 2 &&
        command[0] === NODE_PATH &&
        command[1] === BROKER_ENTRY_PATH;
      if (isBroker) {
        if (options.primaryAddTerminationUnconfirmed) {
          registration = createBrokerRegistration();
          return terminationUnconfirmed("timeout");
        }
        if (options.primaryAddFailure) {
          registration = null;
          return { started: true, exitCode: 1, stdout: "", stderr: "partial failure\n" };
        }
        registration = primaryVerificationFailurePending
          ? null
          : options.brokerReadbackOmitsAuthStatus
            ? withoutAuthStatus(createBrokerRegistration())
            : createBrokerRegistration();
        primaryVerificationFailurePending = false;
        return success("Added global MCP server 'meanthis'.");
      }
      registration = createManagedMainStdioRegistration("meanthis");
      return success("Restored global MCP server 'meanthis'.");
    }
    if (args.slice(0, 3).join(" ") === "mcp add ui-attach") {
      legacyRegistration = createManagedMainStdioRegistration("ui-attach");
      return success("Restored global MCP server 'ui-attach'.");
    }
    if (args.slice(0, 3).join(" ") === "mcp add meanthis-source-resolver") {
      if (options.resolverRestoreFailure) {
        return { started: true, exitCode: 1, stdout: "", stderr: "restore failed\n" };
      }
      resolverRegistration = createManagedResolverStdioRegistration();
      return success("Restored global MCP server 'meanthis-source-resolver'.");
    }
    if (key === "mcp remove meanthis") {
      registration = null;
      if (options.primaryRemoveFailure) {
        return { started: true, exitCode: 1, stdout: "", stderr: "partial failure\n" };
      }
      return success("Removed global MCP server 'meanthis'.");
    }
    if (key === "mcp remove ui-attach") {
      legacyRegistration = null;
      return success("Removed global MCP server 'ui-attach'.");
    }
    if (key === "mcp remove meanthis-source-resolver") {
      resolverRegistration = null;
      if (options.resolverRemoveFailure) {
        return { started: true, exitCode: 1, stdout: "", stderr: "partial failure\n" };
      }
      return success("Removed global MCP server 'meanthis-source-resolver'.");
    }
    return { started: true, exitCode: 1, stdout: "", stderr: "Unexpected command.\n" };
  });
  const approveConnectionRequest = vi.fn(async (requestId: string) => ({
    requestId,
    approvalMode: "ask" as const,
    expiresAt: "2026-07-17T04:32:00.000Z",
  }));
  const installNativeHost = vi.fn(async () => ({
    status: "installed" as const,
    browsers: ["chrome" as const, "edge" as const],
  }));
  const inspectMcpHttpCredential = vi.fn(async () => credentialStatus === "ready"
    ? { kind: "mcp-http-key-v1" as const, status: "ready" as const, fingerprint: "sha256:1234567890abcdef" }
    : { kind: "mcp-http-key-v1" as const, status: credentialStatus });
  const inspectAgentCredential = vi.fn(async () => agentCredentialStatus === "ready"
    ? {
        kind: "bridge-agent-key-v2" as const,
        status: "ready" as const,
        fingerprint: fingerprintLocalBridgeAgentToken(
          options.spoofAgentInspectionFingerprint ? AGENT_TOKEN : storedAgentToken,
        ),
      }
    : { kind: "bridge-agent-key-v2" as const, status: agentCredentialStatus });
  const loadOrCreateMcpHttpToken = vi.fn(async () => {
    if (options.rotationRequired) throw new LocalBridgeMcpHttpTokenRotationRequiredError();
    if (options.tokenError) throw new Error("token unavailable");
    credentialStatus = "ready";
    return MCP_TOKEN;
  });
  const readMcpHttpToken = vi.fn(async () => storedToken);
  const readAgentToken = vi.fn(async () => storedAgentToken);
  const rotateMcpHttpToken = vi.fn(async () => {
    if (options.tokenRotationError) throw new Error("mcp credential unavailable");
    if (options.tokenRotationCommittedButUnverified) {
      throw new LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError();
    }
    credentialStatus = "ready";
    storedToken = options.rotationFinalTokenMismatch ? `B${MCP_TOKEN.slice(1)}` : MCP_TOKEN;
    return MCP_TOKEN;
  });
  const rotateAgentToken = vi.fn(async () => {
    if (options.agentTokenRotationCommittedButUnverified) {
      throw new LocalBridgeAgentTokenRotationCommittedButUnverifiedError();
    }
    if (options.agentTokenError) throw new Error("agent credential unavailable");
    agentCredentialStatus = "ready";
    storedAgentToken = AGENT_TOKEN;
    return AGENT_TOKEN;
  });
  const ensureBrowserOwner = vi.fn(async (_expectedAgentToken?: string) => {
    if (options.agentCredentialDriftsBeforeOwnerEnsure) storedAgentToken = DRIFTED_AGENT_TOKEN;
    if (options.agentRotationRequired) throw new LocalBridgeAgentTokenRotationRequiredError();
    if (options.browserOwnerError) throw new Error("browser owner unavailable");
    if (options.agentCredentialDriftsAfterOwnerEnsure) storedAgentToken = DRIFTED_AGENT_TOKEN;
  });
  const ensureMcpHttpOwner = vi.fn(async () => {
    if (options.mcpLegacyForeground) throw new LocalBridgeMcpHttpLegacyForegroundOwnerError();
    if (options.mcpUnverifiedListener) throw new LocalBridgeMcpHttpUnverifiedListenerError();
    if (options.mcpOwnerError) throw new Error("mcp owner unavailable");
    if (options.ownerGate) await options.ownerGate;
    mcpHealth = "ready";
  });
  const dependencies: BridgeCliDependencies = {
    nodePath: NODE_PATH,
    entryPath: ENTRY_PATH,
    brokerEntryPath: BROKER_ENTRY_PATH,
    standaloneResolverEntryPath: RESOLVER_ENTRY_PATH,
    pathExists: vi.fn(async () => true),
    probeBrowserOwner: vi.fn(async () => options.browserHealth ?? "not_running"),
    probeMcpHttpOwner: vi.fn(async () => mcpHealth),
    inspectAgentCredential,
    inspectMcpHttpCredential,
    loadOrCreateMcpHttpToken,
    readAgentToken,
    readMcpHttpToken,
    rotateMcpHttpToken,
    rotateAgentToken,
    acquireBridgeProfileLock,
    backupCodexConfig,
    runCodex,
    ensureBrowserOwner,
    ensureMcpHttpOwner,
    approveConnectionRequest,
    installNativeHost,
  };
  return {
    acquireBridgeProfileLock,
    approveConnectionRequest,
    backupCodexConfig,
    dependencies,
    ensureBrowserOwner,
    ensureMcpHttpOwner,
    getLegacyRegistration: () => legacyRegistration,
    getRegistration: () => registration,
    getResolverRegistration: () => resolverRegistration,
    inspectMcpHttpCredential,
    installNativeHost,
    inspectAgentCredential,
    io,
    loadOrCreateMcpHttpToken,
    readMcpHttpToken,
    readAgentToken,
    rotateMcpHttpToken,
    rotateAgentToken,
    releaseBridgeProfileLock,
    runCodex,
  };
}

function registrationResult(name: string, registration: unknown): CodexProcessResult {
  return registration
    ? { started: true, exitCode: 0, stdout: `${JSON.stringify(registration)}\n`, stderr: "" }
    : {
        started: true,
        exitCode: 1,
        stdout: "",
        stderr: `Error: No MCP server named '${name}' found.\n`,
      };
}

function success(stdout: string): CodexProcessResult {
  return { started: true, exitCode: 0, stdout: `${stdout}\n`, stderr: "" };
}

function terminationUnconfirmed(
  terminationReason: "timeout" | "output_limit",
): CodexProcessResult {
  return {
    started: true,
    exitCode: null,
    stdout: "",
    stderr: "",
    terminationStatus: "termination_unconfirmed",
    terminationReason,
  };
}

interface FakeRunProcessChild extends RunProcessChild {
  emitStdout(chunk: Buffer): void;
  emitStderr(chunk: Buffer): void;
  emitError(error: Error): void;
  emitClose(exitCode: number | null): void;
}

function createFakeRunProcessChild(pid: number): FakeRunProcessChild {
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const stderrListeners: Array<(chunk: Buffer) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const closeListeners: Array<(exitCode: number | null) => void> = [];
  let exitCode: number | null = null;
  return {
    pid,
    get exitCode() { return exitCode; },
    signalCode: null,
    onStdout(listener) { stdoutListeners.push(listener); },
    onStderr(listener) { stderrListeners.push(listener); },
    onceError(listener) { errorListeners.push(listener); },
    onceClose(listener) { closeListeners.push(listener); },
    emitStdout(chunk) { for (const listener of stdoutListeners) listener(chunk); },
    emitStderr(chunk) { for (const listener of stderrListeners) listener(chunk); },
    emitError(error) { for (const listener of errorListeners.splice(0)) listener(error); },
    emitClose(nextExitCode) {
      exitCode = nextExitCode;
      for (const listener of closeListeners.splice(0)) listener(nextExitCode);
    },
  };
}

function createHttpRegistration() {
  return {
    name: "meanthis",
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "streamable_http",
      url: MCP_URL,
      bearer_token_env_var: MCP_TOKEN_ENV,
      http_headers: null,
      env_http_headers: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: "bearer_token",
  } as const;
}

function createForeignHttpRegistration() {
  return {
    ...createHttpRegistration(),
    transport: {
      ...createHttpRegistration().transport,
      bearer_token_env_var: "FOREIGN_SECRET_ENV",
    },
    foreignMarker: "foreign-secret",
  } as const;
}

function createBrokerRegistration() {
  return createStdioRegistration("meanthis", BROKER_ENTRY_PATH, [BROKER_ENTRY_PATH]);
}

function createManagedMainStdioRegistration(name: "meanthis" | "ui-attach") {
  return createStdioRegistration(name, ENTRY_PATH, [ENTRY_PATH, "mcp"]);
}

function createManagedResolverStdioRegistration(entryPath = RESOLVER_ENTRY_PATH) {
  return createStdioRegistration("meanthis-source-resolver", entryPath, [entryPath]);
}

function createStdioRegistration(name: string, _entryPath: string, args: string[]) {
  return {
    name,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: NODE_PATH,
      args,
      env: null,
      env_vars: [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: "unsupported",
  } as const;
}

function withoutAuthStatus<T extends { auth_status: unknown }>(
  registration: T,
): Omit<T, "auth_status"> {
  const { auth_status: _authStatus, ...readback } = registration;
  return readback;
}

function createTestIo(): BridgeCliIo & { stdout: string; stderr: string } {
  return {
    stdout: "",
    stderr: "",
    writeStdout(value) {
      this.stdout += value;
    },
    writeStderr(value) {
      this.stderr += value;
    },
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
