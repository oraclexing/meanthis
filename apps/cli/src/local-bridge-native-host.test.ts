import { Readable, Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN,
  decodeNativeMessageFrame,
  encodeNativeMessageFrame,
  handleNativeBridgeStartRequest,
  probeActiveLocalBridgeOwners,
  runLocalBridgeNativeMessagingHost,
  runNativeBridgeStart,
} from "./local-bridge-native-host";

const REQUEST_ID = "01234567-89ab-4cde-8fab-0123456789ab";

describe("local bridge native messaging host", () => {
  test("skips doctor and owner restart when both authenticated owner proofs are current", async () => {
    const probeActiveOwners = vi.fn(async () => true);
    const runBridgeCommand = vi.fn();

    await expect(runNativeBridgeStart({
      probeActiveOwners,
      runBridgeCommand,
    })).resolves.toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.bridge-start",
        ok: true,
        data: {
          runtimeActive: true,
          browserOrigin: "http://127.0.0.1:38471",
          mcpHttpUrl: "http://127.0.0.1:38472/mcp",
        },
      })}\n`,
      stderr: "",
    });
    expect(probeActiveOwners).toHaveBeenCalledOnce();
    expect(runBridgeCommand).not.toHaveBeenCalled();
  });

  test.each(["unavailable", "failed"] as const)(
    "falls back to doctor then start when the authenticated fast probe is %s",
    async (state) => {
      const probeActiveOwners = vi.fn(async () => {
        if (state === "failed") throw new Error("bounded probe failure");
        return false;
      });
      const runBridgeCommand = vi.fn(async (args: string[]) => args[0] === "doctor"
        ? doctorReady(true)
        : bridgeStartReady());

      await expect(runNativeBridgeStart({
        probeActiveOwners,
        runBridgeCommand,
      })).resolves.toEqual(bridgeStartReady());
      expect(runBridgeCommand.mock.calls).toEqual([
        [["doctor", "--json"]],
        [["start", "--json"]],
      ]);
    },
  );

  test("does not trust the fast proof when doctor reports an inactive runtime", async () => {
    const probeActiveOwners = vi.fn(async () => false);
    const runBridgeCommand = vi.fn(async (args: string[]) => args[0] === "doctor"
      ? doctorReady(false)
      : bridgeStartReady());

    await expect(runNativeBridgeStart({
      probeActiveOwners,
      runBridgeCommand,
    })).resolves.toEqual(bridgeStartReady());
    expect(runBridgeCommand.mock.calls).toEqual([
      [["doctor", "--json"]],
      [["start", "--json"]],
    ]);
    expect(probeActiveOwners).toHaveBeenCalledOnce();
  });

  test("keeps typed doctor failures fail-closed after the fast proof fails", async () => {
    const probeActiveOwners = vi.fn(async () => false);
    const runBridgeCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.bridge-doctor",
        ok: true,
        data: {
          checks: {
            registration: { status: "current" },
            agentCredential: { status: "insecure" },
            credential: { status: "ready" },
            mcpHttpOwner: { status: "ready" },
          },
          registrationReady: false,
          runtimeActive: false,
        },
      })}\n`,
      stderr: "",
    }));

    await expect(runNativeBridgeStart({
      probeActiveOwners,
      runBridgeCommand,
    })).resolves.toMatchObject({
      exitCode: 5,
      stdout: "",
      stderr: expect.stringContaining("BRIDGE_ACTION_REQUIRED"),
    });
    expect(runBridgeCommand.mock.calls).toEqual([
      [["doctor", "--json"]],
    ]);
  });

  test("accepts an authenticated production probe only after an identical verified readback", async () => {
    const snapshot = activeOwnersSnapshot();
    const readSnapshot = vi.fn(async () => snapshot);
    const proveOwners = vi.fn(async () => undefined);

    await expect(probeActiveLocalBridgeOwners({
      readSnapshot,
      proveOwners,
    })).resolves.toBe(true);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(proveOwners).toHaveBeenCalledWith(snapshot);
  });

  test.each([
    ["agent token", (snapshot: ReturnType<typeof activeOwnersSnapshot>) => ({
      ...snapshot,
      agentToken: "b".repeat(43),
    })],
    ["MCP token", (snapshot: ReturnType<typeof activeOwnersSnapshot>) => ({
      ...snapshot,
      mcpHttpToken: "d".repeat(43),
    })],
    ["browser build", (snapshot: ReturnType<typeof activeOwnersSnapshot>) => ({
      ...snapshot,
      browserOwnerIdentity: {
        ...snapshot.browserOwnerIdentity,
        buildHash: "2".repeat(64),
      },
    })],
    ["MCP build", (snapshot: ReturnType<typeof activeOwnersSnapshot>) => ({
      ...snapshot,
      mcpHttpOwnerIdentity: {
        ...snapshot.mcpHttpOwnerIdentity,
        buildHash: "4".repeat(64),
      },
    })],
  ] as const)("rejects %s drift that occurs while authenticated proofs are pending", async (
    _label,
    drift,
  ) => {
    const before = activeOwnersSnapshot();
    const after = drift(before);
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    let releaseProof!: () => void;
    const proveOwners = vi.fn(() => new Promise<void>((resolve) => {
      releaseProof = resolve;
    }));
    const runBridgeCommand = vi.fn(async (args: string[]) => args[0] === "doctor"
      ? doctorReady(true)
      : bridgeStartReady());

    const pending = runNativeBridgeStart({
      probeActiveOwners: () => probeActiveLocalBridgeOwners({ readSnapshot, proveOwners }),
      runBridgeCommand,
    });
    await vi.waitFor(() => expect(proveOwners).toHaveBeenCalledOnce());
    releaseProof();

    await expect(pending).resolves.toEqual(bridgeStartReady());
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(runBridgeCommand.mock.calls).toEqual([
      [["doctor", "--json"]],
      [["start", "--json"]],
    ]);
  });

  test("starts the bridge only for the pinned extension origin", async () => {
    const startBridge = vi.fn(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.bridge-start",
        ok: true,
        data: { runtimeActive: true },
      })}\n`,
      stderr: "",
    }));

    await expect(handleNativeBridgeStartRequest({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN, "--parent-window=0"],
      message: request(),
      startBridge,
    })).resolves.toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.native-bridge-start-result",
      requestId: REQUEST_ID,
      ok: true,
      data: { status: "ready" },
    });
    expect(startBridge).toHaveBeenCalledOnce();

    await expect(handleNativeBridgeStartRequest({
      callerArgs: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
      message: request(),
      startBridge,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "NATIVE_CALLER_FORBIDDEN" },
    });
    expect(startBridge).toHaveBeenCalledOnce();
  });

  test("runs credential repair only for the explicit repair request", async () => {
    const startBridge = vi.fn();
    const repairBridge = vi.fn(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.bridge-start",
        ok: true,
        data: { runtimeActive: true },
      })}\n`,
      stderr: "",
    }));

    await expect(handleNativeBridgeStartRequest({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
      message: { ...request(), kind: "ui-attach.native-bridge-repair" },
      startBridge,
      repairBridge,
    })).resolves.toMatchObject({ ok: true, data: { status: "ready" } });
    expect(repairBridge).toHaveBeenCalledOnce();
    expect(startBridge).not.toHaveBeenCalled();
  });

  test.each([
    "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED",
    "MCP_HTTP_CREDENTIAL_ROTATION_REQUIRED",
  ])("fails closed without exposing CLI diagnostics for %s", async (code) => {
    const response = await handleNativeBridgeStartRequest({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
      message: request(),
      startBridge: async () => ({
        exitCode: 5,
        stdout: "",
        stderr: `${JSON.stringify({
          schemaVersion: "0.1.0",
          kind: "ui-attach.error",
          ok: false,
          error: {
            code,
            message: "raw diagnostic must not cross native messaging",
            next: "raw command must not cross native messaging",
          },
        })}\n`,
      }),
    });

    expect(response).toMatchObject({
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "BRIDGE_REPAIR_REQUIRED" },
    });
    expect(JSON.stringify(response)).not.toContain("raw diagnostic");
    expect(JSON.stringify(response)).not.toContain("raw command");
  });

  test.each([
    "MCP_HTTP_UNVERIFIED_LISTENER",
    "MCP_HTTP_LEGACY_FOREGROUND_OWNER",
  ])("requires manual listener action without offering credential repair for %s", async (code) => {
    const response = await handleNativeBridgeStartRequest({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
      message: request(),
      startBridge: async () => ({
        exitCode: 5,
        stdout: "",
        stderr: `${JSON.stringify({ ok: false, error: { code } })}\n`,
      }),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "BRIDGE_ACTION_REQUIRED" },
    });
  });

  test("separates one-time setup from credential rotation", async () => {
    const response = await handleNativeBridgeStartRequest({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
      message: request(),
      startBridge: async () => ({
        exitCode: 5,
        stdout: "",
        stderr: `${JSON.stringify({ ok: false, error: { code: "BRIDGE_SETUP_REQUIRED" } })}\n`,
      }),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "BRIDGE_SETUP_REQUIRED" },
    });
  });

  test("uses one bounded length-prefixed message in each direction", async () => {
    const input = encodeNativeMessageFrame(request());
    const output: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });

    await runLocalBridgeNativeMessagingHost({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
      stdin: Readable.from([input.subarray(0, 3), input.subarray(3)]),
      stdout,
      startBridge: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          schemaVersion: "0.1.0",
          kind: "ui-attach.bridge-start",
          ok: true,
          data: { runtimeActive: true },
        })}\n`,
        stderr: "",
      }),
    });

    expect(decodeNativeMessageFrame(Buffer.concat(output))).toMatchObject({
      requestId: REQUEST_ID,
      ok: true,
      data: { status: "ready" },
    });
    expect(() => decodeNativeMessageFrame(Buffer.concat([
      input,
      Buffer.from([0]),
    ]))).toThrow("invalid");
  });

  test("rejects a second frame and checks the caller before reading stdin", async () => {
    const output: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });
    const duplicate = Buffer.concat([
      encodeNativeMessageFrame(request()),
      encodeNativeMessageFrame(request()),
    ]);

    await runLocalBridgeNativeMessagingHost({
      callerArgs: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
      stdin: Readable.from([duplicate]),
      stdout,
    });
    expect(decodeNativeMessageFrame(Buffer.concat(output))).toMatchObject({
      error: { code: "NATIVE_REQUEST_INVALID" },
    });

    output.length = 0;
    const unreadable = new Readable({
      read() {
        throw new Error("stdin must not be read for a forbidden caller");
      },
    });
    await runLocalBridgeNativeMessagingHost({
      callerArgs: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
      stdin: unreadable,
      stdout,
    });
    expect(decodeNativeMessageFrame(Buffer.concat(output))).toMatchObject({
      error: { code: "NATIVE_CALLER_FORBIDDEN" },
    });
  });
});

function request() {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.native-bridge-start",
    requestId: REQUEST_ID,
  };
}

function doctorReady(runtimeActive: boolean) {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-doctor",
      ok: true,
      data: {
        checks: {
          registration: { status: "current" },
          agentCredential: { status: "ready" },
          credential: { status: "ready" },
          mcpHttpOwner: { status: "ready" },
        },
        registrationReady: true,
        runtimeActive,
      },
    })}\n`,
    stderr: "",
  };
}

function bridgeStartReady() {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-start",
      ok: true,
      data: {
        runtimeActive: true,
        browserOrigin: "http://127.0.0.1:38471",
        mcpHttpUrl: "http://127.0.0.1:38472/mcp",
      },
    })}\n`,
    stderr: "",
  };
}

function activeOwnersSnapshot() {
  return {
    agentToken: "a".repeat(43),
    mcpHttpToken: "c".repeat(43),
    browserOwnerIdentity: {
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      entryPath: "D:\\MeanThis\\dist\\index.js",
      buildHash: "1".repeat(64),
    },
    mcpHttpOwnerIdentity: {
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      entryPath: "D:\\MeanThis\\dist\\index.js",
      buildHash: "3".repeat(64),
    },
  };
}
