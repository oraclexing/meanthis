import { describe, expect, test, vi } from "vitest";
import {
  renderCaptureHelp,
  runCaptureCli,
  type CaptureCliDependencies,
  type CaptureCliIo,
} from "./capture-cli";
import type { LocalBridgeReader } from "./local-bridge-mcp";

const INSTANCE_ID = "instance-123456abcdef";

describe("meanthis capture CLI", () => {
  test("lists captures through the same progressive read contract", async () => {
    const harness = createHarness();

    const exitCode = await runCaptureCli(
      ["list", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.ensureOwner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.capture-list",
      state: "captures_available",
      nextAction: {
        kind: "read_capture",
        tool: "meanthis_read_capture",
        cli: {
          executable: "meanthis",
          arguments: [
            "capture",
            "read",
            "--instance",
            INSTANCE_ID,
            "--capture",
            "session-1",
            "--sequence",
            "1",
            "--detail",
            "summary",
            "--json",
          ],
        },
      },
      captures: [{ captureId: "session-1", targetCount: 1 }],
    });
  });

  test("reads one target by capture-scoped target id without raw MCP JSON-RPC", async () => {
    const harness = createHarness();

    const exitCode = await runCaptureCli(
      [
        "read",
        "--instance",
        INSTANCE_ID,
        "--capture",
        "session-1",
        "--sequence",
        "1",
        "--detail",
        "summary",
        "--target",
        "target_A",
        "--json",
      ],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.capture-read",
      detail: "summary",
      nextAction: {
        kind: "ack_capture_read",
        tool: "meanthis_ack_capture_read",
        arguments: {
          instanceId: INSTANCE_ID,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "summary",
        },
        cli: {
          executable: "meanthis",
          arguments: [
            "capture",
            "ack",
            "--instance",
            INSTANCE_ID,
            "--capture",
            "session-1",
            "--sequence",
            "1",
            "--detail",
            "summary",
            "--json",
          ],
        },
      },
      capture: {
        captureId: "session-1",
        targetIdScope: "capture",
        targets: [{ targetId: "target_A", targetIdScope: "capture", label: "A" }],
      },
    });
  });

  test("reads composite Agent context through the host-neutral CLI", async () => {
    const harness = createHarness({ taskNote: "Shorten the label." });

    const exitCode = await runCaptureCli(
      [
        "read",
        "--instance",
        INSTANCE_ID,
        "--capture",
        "session-1",
        "--sequence",
        "1",
        "--detail",
        "agent_context",
        "--target",
        "target_A",
        "--json",
      ],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.sourceResolver).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      detail: "agent_context",
      capture: {
        targets: [{
          targetId: "target_A",
          task: {
            text: "Shorten the label.",
            intentStatus: "user_authored_task_note",
          },
          grounding: {
            recommendedLocator: {
              strategy: "playwright.role",
              value: "page.getByRole(\"button\", { name: \"Save changes\" })",
            },
            sourceResolution: {
              status: "unavailable",
              reason: "source_anchor_missing",
            },
          },
          visual: {
            bbox: { x: 10, y: 20, width: 80, height: 32 },
            visible: true,
            enabled: true,
          },
        }],
      },
    });
  });

  test("acknowledges one exact current read through the host-neutral CLI", async () => {
    const harness = createHarness();

    const exitCode = await runCaptureCli(
      [
        "ack",
        "--instance",
        INSTANCE_ID,
        "--capture",
        "session-1",
        "--sequence",
        "1",
        "--detail",
        "agent_context",
        "--json",
      ],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      acknowledgement: {
        kind: "ui-attach.local-bridge-read-acknowledgement",
        status: "acknowledged_by_agent_client",
        instanceId: INSTANCE_ID,
        captureId: "session-1",
        snapshotSequence: 1,
        detail: "agent_context",
        acknowledgementId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      },
      limitations: [
        "does_not_prove_model_attention",
        "does_not_prove_task_creation",
        "does_not_prove_downstream_execution",
      ],
    });
  });

  test("keeps capture CLI list/read on the V3 production projection and relist error route", async () => {
    const harness = createHarness({ annotationLifecycleVersion: "v1" });

    expect(await runCaptureCli(["list", "--json"], harness.io, harness.dependencies)).toBe(0);
    const listed = JSON.parse(harness.io.stdout);
    expect(listed.captures[0]).toMatchObject({
      captureId: "session-1",
      annotationLifecycleVersion: "v1",
      snapshot: { sequence: 1 },
    });
    expect(listed.captures[0]).not.toHaveProperty("targets");
    expect(listed.captures[0]).not.toHaveProperty("annotationLifecycle");

    harness.io.stdout = "";
    expect(await runCaptureCli([
      "read",
      "--instance", INSTANCE_ID,
      "--capture", "session-1",
      "--sequence", "1",
      "--detail", "summary",
      "--json",
    ], harness.io, harness.dependencies)).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      capture: {
        annotationLifecycleVersion: "v1",
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
        targets: [{ annotationLifecycle: { state: "open", resolvedAt: null } }],
      },
    });

    harness.io.stderr = "";
    expect(await runCaptureCli([
      "read",
      "--instance", INSTANCE_ID,
      "--capture", "session-1",
      "--sequence", "2",
      "--detail", "summary",
      "--json",
    ], harness.io, harness.dependencies)).toBe(4);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "CAPTURE_CHANGED", nextAction: { kind: "relist_captures" } },
    });
  });

  test("reads capture-level replay diagnostics through the host-neutral CLI", async () => {
    const harness = createHarness({ metadataDiagnostics: true });

    expect(await runCaptureCli([
      "read",
      "--instance", INSTANCE_ID,
      "--capture", "session-1",
      "--sequence", "1",
      "--detail", "diagnostics",
      "--json",
    ], harness.io, harness.dependencies)).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      detail: "diagnostics",
      capture: {
        captureId: "session-1",
        metadataDiagnostics: {
          replay: {
            status: "collected",
            attemptCount: 1,
            verifiedCount: 1,
          },
          device: { status: "not_requested" },
          network: { status: "not_requested" },
          console: { status: "not_requested" },
        },
      },
    });
    expect(JSON.parse(harness.io.stdout).capture).not.toHaveProperty("page");
    expect(harness.io.stdout).not.toContain("/settings");
  });

  test("rejects ambiguous or incomplete read selectors before touching the owner", async () => {
    const harness = createHarness();

    expect(await runCaptureCli(
      [
        "read",
        "--instance",
        INSTANCE_ID,
        "--capture",
        "session-1",
        "--sequence",
        "1",
        "--target",
        "target_A",
        "--attachment",
        "att_save",
        "--json",
      ],
      harness.io,
      harness.dependencies,
    )).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(harness.ensureOwner).not.toHaveBeenCalled();
  });

  test("documents the host-neutral fallback commands", () => {
    expect(renderCaptureHelp()).toContain("meanthis capture list --json");
    expect(renderCaptureHelp()).toContain("meanthis capture read --instance");
    expect(renderCaptureHelp()).toContain("meanthis capture ack --instance");
    expect(renderCaptureHelp()).toContain("--detail agent_context");
  });
});

function createHarness(options?: {
  annotationLifecycleVersion?: "v1";
  metadataDiagnostics?: true;
  taskNote?: string;
}): {
  io: CaptureCliIo & { stdout: string; stderr: string };
  dependencies: CaptureCliDependencies;
  ensureOwner: ReturnType<typeof vi.fn>;
  sourceResolver: ReturnType<typeof vi.fn>;
} {
  const io = {
    stdout: "",
    stderr: "",
    writeStdout(value: string) { this.stdout += value; },
    writeStderr(value: string) { this.stderr += value; },
  };
  const snapshot = {
    sequence: 1,
    publishedAt: "2026-08-09T01:00:00.000Z",
    page: {
      pageInstanceId: "chromium-tab:7:frame:0",
      route: "https://example.test/settings",
    },
    attachmentCount: 1,
    agentCopy: "Agent-safe handoff.",
    capture: {
      captureId: "session-1",
      title: "Settings review",
      origin: "https://example.test",
      updatedAt: "2026-08-09T01:00:00.000Z",
      authority: "capture_time",
      disclosureMode: "agent_safe",
      ...(options?.annotationLifecycleVersion === "v1"
        ? { annotationLifecycleVersion: "v1" as const }
        : {}),
      ...(options?.metadataDiagnostics
        ? {
            metadataDiagnostics: {
              schemaVersion: "0.1.0" as const,
              kind: "ui-attach.metadata-only-diagnostics" as const,
              captureId: "session-1",
              scope: "capture" as const,
              observedAt: "2026-08-09T01:00:00.000Z",
              consent: "explicit_capture" as const,
              authority: "capture_time" as const,
              replay: {
                status: "collected" as const,
                attemptCount: 1,
                verifiedCount: 1,
                ambiguousCount: 0,
                missingCount: 0,
              },
              device: { status: "not_requested" as const },
              network: { status: "not_requested" as const },
              console: { status: "not_requested" as const },
              executionAuthority: {
                grantedByCapture: false as const,
                browserControl: false as const,
                liveDomMutation: false as const,
              },
            },
          }
        : {}),
      targets: [{
        targetId: "target_A",
        attachmentId: "att_save",
        label: "A",
        taskNote: options?.taskNote ?? "",
        ...(options?.annotationLifecycleVersion === "v1"
          ? { annotationLifecycle: { state: "open" as const, resolvedAt: null } }
          : {}),
        attachment: {
          capturedAt: "2026-08-09T01:00:00.000Z",
          element: {
            tagName: "button",
            role: "button",
            accessibleName: "Save changes",
            text: "Save",
            bbox: { x: 10, y: 20, width: 80, height: 32 },
            visible: true,
            enabled: true,
          },
          style: { display: "inline-flex" },
          locatorBundle: {
            primary: {
              strategy: "playwright.role",
              value: "page.getByRole(\"button\", { name: \"Save changes\" })",
              confidence: 0.92,
            },
          },
        },
      }],
    },
  };
  const reader = {
    getStatus: () => { throw new Error("not used"); },
    listInstances: () => [{ instanceId: INSTANCE_ID, stale: false }],
    readInstance: (instanceId: string) => ({
      ok: true as const,
      value: { instanceId, stale: false, snapshot },
    }),
    acknowledgeCaptureRead: async (acknowledgement: any) => ({
      ok: true as const,
      value: acknowledgement,
    }),
  } as unknown as LocalBridgeReader;
  const ensureOwner = vi.fn(async () => {});
  const sourceResolver = vi.fn(async (inputs: readonly unknown[]) => inputs.map(() => ({
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.source-resolution" as const,
    status: "unavailable" as const,
    reason: "source_anchor_missing" as const,
  })));
  return {
    io,
    dependencies: { reader, ensureOwner, sourceResolver },
    ensureOwner,
    sourceResolver,
  };
}
