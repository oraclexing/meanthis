import { describe, expect, test, vi } from "vitest";
import {
  renderAnnotationLifecycleControlHelp,
  runAnnotationLifecycleControlCli,
} from "./annotation-lifecycle-control-cli";

describe("annotation lifecycle control CLI", () => {
  test("submits an exact lifecycle proposal through the separate control plane", async () => {
    const request = vi.fn(async () => ({ ok: true, data: { phase: "awaiting_user" } }));
    const io = createIo();
    const exit = await runAnnotationLifecycleControlCli([
      "submit",
      "--instance", "instance-0123456789ab",
      "--capture", "capture-1",
      "--sequence", "7",
      "--annotation", "annotation:1",
      "--expected", "open",
      "--next", "resolved",
      "--operation", "11111111-1111-4111-8111-111111111111",
      "--json",
    ], io, { ensureOwner: vi.fn(async () => undefined), request });

    expect(exit).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "/v1/agent/annotation-lifecycle/proposals",
      {
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-operation",
        operationId: "11111111-1111-4111-8111-111111111111",
        instanceId: "instance-0123456789ab",
        captureId: "capture-1",
        expectedSequence: 7,
        annotationId: "annotation:1",
        expectedState: "open",
        nextState: "resolved",
      },
    );
    expect(io.stderr).toBe("");
    expect(JSON.parse(io.stdout)).toEqual({ ok: true, data: { phase: "awaiting_user" } });
  });

  test("reads status only with an exact owner-bound reference", async () => {
    const request = vi.fn(async () => ({ ok: true, data: { phase: "applied" } }));
    const io = createIo();
    const exit = await runAnnotationLifecycleControlCli([
      "status",
      "--operation", "11111111-1111-4111-8111-111111111111",
      "--fingerprint", "a".repeat(64),
      "--owner-generation", "2",
      "--connection-generation", "3",
      "--json",
    ], io, { ensureOwner: vi.fn(async () => undefined), request });
    expect(exit).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "/v1/agent/annotation-lifecycle/proposals/status",
      {
        operationId: "11111111-1111-4111-8111-111111111111",
        fingerprint: "a".repeat(64),
        ownerGeneration: 2,
        connectionGeneration: 3,
      },
    );
  });

  test("fails closed for invalid transitions, incomplete references and request failures", async () => {
    const dependency = {
      ensureOwner: vi.fn(async () => undefined),
      request: vi.fn(async () => ({ ok: true })),
    };
    for (const args of [
      [
        "submit", "--instance", "instance-0123456789ab", "--capture", "capture-1",
        "--sequence", "7", "--annotation", "annotation:1", "--expected", "open",
        "--next", "open", "--json",
      ],
      ["status", "--operation", "11111111-1111-4111-8111-111111111111", "--json"],
    ]) {
      const io = createIo();
      await expect(runAnnotationLifecycleControlCli(args, io, dependency)).resolves.toBe(2);
      expect(JSON.parse(io.stderr).error.code).toBe("INVALID_ARGUMENTS");
    }

    const io = createIo();
    dependency.request.mockRejectedValueOnce(new Error("secret owner failure"));
    await expect(runAnnotationLifecycleControlCli([
      "status",
      "--operation", "11111111-1111-4111-8111-111111111111",
      "--fingerprint", "a".repeat(64),
      "--owner-generation", "2",
      "--connection-generation", "3",
      "--json",
    ], io, dependency)).resolves.toBe(5);
    expect(io.stderr).not.toContain("secret owner failure");
  });

  test("preserves an authenticated owner rejection without misreporting owner availability", async () => {
    const io = createIo();
    const response = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-error",
      ok: false,
      error: {
        code: "EXPECTED_SEQUENCE_MISMATCH",
        message: "Annotation lifecycle operation was rejected.",
      },
    };
    const exit = await runAnnotationLifecycleControlCli([
      "submit",
      "--instance", "instance-0123456789ab",
      "--capture", "capture-1",
      "--sequence", "7",
      "--annotation", "annotation:1",
      "--expected", "open",
      "--next", "resolved",
      "--operation", "11111111-1111-4111-8111-111111111111",
      "--json",
    ], io, {
      ensureOwner: vi.fn(async () => undefined),
      request: vi.fn(async () => response),
    });

    expect(exit).toBe(4);
    expect(io.stdout).toBe("");
    expect(JSON.parse(io.stderr)).toEqual(response);
  });

  test("renders a bounded help surface separate from MCP", async () => {
    const io = createIo();
    await expect(runAnnotationLifecycleControlCli(["--help"], io, {
      ensureOwner: vi.fn(),
      request: vi.fn(),
    })).resolves.toBe(0);
    expect(io.stdout).toBe(renderAnnotationLifecycleControlHelp());
    expect(io.stdout).not.toContain("mcp mutation");
  });
});

function createIo() {
  const state = { stdout: "", stderr: "" };
  return {
    get stdout() { return state.stdout; },
    get stderr() { return state.stderr; },
    writeStdout(value: string) { state.stdout += value; },
    writeStderr(value: string) { state.stderr += value; },
  };
}
