import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createSourceContentHash,
  createSourceMapSidecar,
} from "@meanthis/source-map-core";
import type { LocalBridgeCaptureV1 } from "@meanthis/schema";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
  createLocalBridgeState,
} from "./local-bridge";
import { startLocalBridgeHttpServer } from "./local-bridge";
import {
  approveHttpLocalBridgeConnectionRequest,
  connectLocalBridgeMcpSurface,
  createHttpLocalBridgeReader,
  createLocalBridgeMcpServer,
} from "./local-bridge-mcp";
import {
  RESPONSE_PROOF_HEADER,
  createLocalBridgeAgentResponseProof,
  verifyLocalBridgeAgentRequestAuth,
} from "./local-bridge-agent-auth";

const EXTENSION_ORIGIN = `chrome-extension://${MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID}`;
const INSTALLATION_ID = "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3";
const AGENT_TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const APPROVAL_KEY = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
const APPROVAL_VERIFIER = "MIwc-JegXDWE1xhuMLuAumhs4XH1TLOAsg-rk3mfc0E";
const OWNER_IDENTITY = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\ui-attach\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};

function createCapture(): LocalBridgeCaptureV1 {
  return {
    captureId: "session-1",
    title: "Settings review",
    origin: "https://example.test",
    updatedAt: "2026-07-17T04:29:58.000Z",
    authority: "capture_time",
    disclosureMode: "agent_safe",
    targets: [{
      attachmentId: "att_save",
      label: "A",
      taskNote: "Shorten the label.",
      attachment: {
        schemaVersion: "0.3.0",
        id: "att_save",
        capturedAt: "2026-07-17T04:29:58.000Z",
        source: { kind: "web", url: null, title: "Settings" },
        element: {
          tagName: "button",
          role: "button",
          text: "Save",
          accessibleName: "Save changes",
          bbox: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          enabled: true,
        },
        style: {
          display: "inline-flex",
          color: "rgb(255, 255, 255)",
          backgroundColor: "rgb(31, 99, 255)",
        },
        context: {
          parentSummary: "form settings",
          nearbyText: ["Profile", "Cancel"],
          selectorHints: ["button[type=\"submit\"]"],
        },
        locatorBundle: {
          primary: {
            strategy: "playwright.role",
            value: "page.getByRole(\"button\", { name: \"Save changes\" })",
            confidence: 0.92,
          },
          candidates: [],
          stability: {
            score: 78,
            uniqueness: null,
            replayVerified: false,
            failureReason: null,
          },
        },
        policy: {
          disclosureMode: "agent_safe",
          redactionLevel: "strict",
          actionMode: "suggest_patch",
          allowScreenshot: false,
          allowDomSnippet: false,
          allowNetworkSend: false,
          allowedDomains: [],
          redactedFields: ["source.url"],
          sensitiveHints: [],
          includedSensitiveFields: [],
        },
        artifacts: { screenshotCrop: null, overlayImage: null },
      },
    }],
  };
}

describe("local agent bridge MCP read surface", () => {
  test("connects the MCP surface before best-effort bridge owner startup", async () => {
    const events: string[] = [];

    await expect(connectLocalBridgeMcpSurface({
      connect: async () => { events.push("connected"); },
      onReady: () => { events.push("ready"); },
      ensureOwner: async () => {
        events.push("owner-start");
        throw new Error("owner unavailable");
      },
      onOwnerUnavailable: () => { events.push("owner-unavailable"); },
    })).resolves.toBeUndefined();

    expect(events).toEqual([
      "connected",
      "ready",
      "owner-start",
      "owner-unavailable",
    ]);
  });

  test("approves through the authenticated owner without returning the extension credential", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const request = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-connection-request",
      requestId: "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
      requestSecret: "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
      approvalVerifier: APPROVAL_VERIFIER,
      installationId: INSTALLATION_ID,
      browserSessionId: "32b8d92d-c76e-4c72-9f3c-5ba5bf31cd22",
      approvalMode: "ask",
    };
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, request).ok).toBe(true);
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    try {
      const approval = await approveHttpLocalBridgeConnectionRequest(
        http.origin,
        AGENT_TOKEN,
        request.requestId,
        request.approvalMode,
        APPROVAL_KEY,
        { expectedOwnerIdentity: OWNER_IDENTITY },
      );
      expect(approval).toEqual({
        requestId: request.requestId,
        approvalMode: "ask",
        expiresAt: "2026-07-17T04:32:00.000Z",
      });
      expect(JSON.stringify(approval)).not.toMatch(/token|requestSecret/);
      await expect(approveHttpLocalBridgeConnectionRequest(
        http.origin,
        AGENT_TOKEN,
        request.requestId,
        request.approvalMode,
        APPROVAL_KEY,
        { expectedOwnerIdentity: { ...OWNER_IDENTITY, buildHash: "b".repeat(64) } },
      )).rejects.toThrow("not approved");
    } finally {
      await http.close();
    }
  });

  test("keeps the default product surface to progressive capture reads and source resolution", async () => {
    const server = createLocalBridgeMcpServer(createLocalBridgeState());
    const client = new Client({ name: "meanthis-product-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "meanthis_list_captures",
        "meanthis_read_capture",
        "meanthis_resolve_source",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects stale instance views even when a reader adapter returns them as successful", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture: createCapture(),
    })).toMatchObject({ ok: true });

    let throwReads = false;
    const reader = {
      getStatus: () => state.getStatus(),
      listInstances: () => state.listInstances(),
      readInstance(instanceId: string) {
        if (throwReads) throw new Error("owner read failed");
        const result = state.readInstance(instanceId);
        return result.ok
          ? { ok: true as const, value: { ...result.value, stale: true } }
          : result;
      },
    };
    const server = createLocalBridgeMcpServer(reader);
    const client = new Client({ name: "meanthis-stale-adapter-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      expect(JSON.parse(readText(list))).toMatchObject({ captures: [] });

      const read = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(read.isError).toBe(true);
      expect(readText(read)).toContain("INSTANCE_STALE");

      throwReads = true;
      const unavailable = await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      expect(unavailable.isError).toBe(true);
      expect(readText(unavailable)).toContain("BRIDGE_OWNER_UNAVAILABLE");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps legacy diagnostics available on the explicit compatibility surface", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const server = createLocalBridgeMcpServer(state, { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "meanthis_list_captures",
        "meanthis_read_capture",
        "ui_attach_bridge_status",
        "ui_attach_list_instances",
        "ui_attach_read_instance",
        "ui_attach_verify_page_completion",
        "meanthis_resolve_source",
      ]);
      for (const tool of tools.tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }

      const unavailableSource = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: {
          sourceAnchor: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.opaque-source-anchor",
            buildId: "A".repeat(43),
            sourceId: "B".repeat(43),
          },
        },
      });
      expect(unavailableSource.isError).not.toBe(true);
      expect(JSON.parse(readText(unavailableSource))).toMatchObject({
        status: "unavailable",
        reason: "workspace_unavailable",
      });

      const paired = state.pair(
        EXTENSION_ORIGIN,
        {
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-pair",
          pairingCode: "482-193",
          installationId: "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3",
        },
      );
      expect(paired.ok).toBe(true);
      if (!paired.ok) return;
      expect(state.publish(
        EXTENSION_ORIGIN,
        paired.value.token,
        {
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-snapshot",
          sequence: 1,
          publishedAt: "2026-07-17T04:30:00.000Z",
          page: {
            pageInstanceId: "chromium-tab:7:frame:0",
            route: "https://example.test/settings",
          },
          attachmentCount: 1,
          agentCopy: "Agent-safe handoff.",
          capture: createCapture(),
        },
      )).toMatchObject({ ok: true });

      const status = await client.callTool({ name: "ui_attach_bridge_status", arguments: {} });
      expect(readText(status)).toContain('"code":"482-193"');
      expect(readText(status)).not.toContain("token");
      expect(readText(status)).not.toContain("installationId");
      expect(readText(status)).not.toContain("Agent-safe handoff");

      const list = await client.callTool({ name: "ui_attach_list_instances", arguments: {} });
      expect(readText(list)).toContain(paired.value.instanceId);
      expect(readText(list)).not.toContain("Agent-safe handoff");

      const captures = await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      const captureList = JSON.parse(readText(captures));
      expect(captureList).toMatchObject({
        kind: "ui-attach.capture-list",
        captures: [{
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          title: "Settings review",
          targetCount: 1,
          authority: "capture_time",
        }],
      });
      expect(readText(captures)).not.toContain("Save changes");
      expect(readText(captures)).not.toContain("Shorten the label");

      const summary = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(JSON.parse(readText(summary))).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "summary",
        capture: {
          captureId: "session-1",
          targets: [{
            attachmentId: "att_save",
            label: "A",
            taskNotePresent: true,
            element: { tagName: "button", role: "button", accessibleName: "Save changes" },
          }],
        },
      });

      const changed = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 0,
          detail: "summary",
        },
      });
      expect(changed.isError).toBe(true);
      expect(readText(changed)).toContain("CAPTURE_CHANGED");

      const context = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "context",
          attachmentIds: ["att_save"],
        },
      });
      expect(JSON.parse(readText(context))).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "context",
        capture: {
          targets: [{
            attachmentId: "att_save",
            taskNote: "Shorten the label.",
            attachment: { policy: { disclosureMode: "agent_safe" } },
          }],
        },
      });

      const handoff = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "handoff",
        },
      });
      expect(JSON.parse(readText(handoff))).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "handoff",
        capture: { handoff: "Agent-safe handoff." },
      });

      const missingCapture = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-2",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(missingCapture.isError).toBe(true);
      expect(readText(missingCapture)).toContain("CAPTURE_NOT_FOUND");

      const exact = await client.callTool({
        name: "ui_attach_read_instance",
        arguments: { instanceId: paired.value.instanceId },
      });
      expect(exact.isError).not.toBe(true);
      expect(readText(exact)).toContain("Agent-safe handoff");

      const missing = await client.callTool({
        name: "ui_attach_read_instance",
        arguments: { instanceId: "instance-000000000000" },
      });
      expect(missing.isError).toBe(true);
      expect(readText(missing)).toContain("INSTANCE_NOT_FOUND");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns deterministic page-completion receipts from one current snapshot", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 4,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 4,
      agentCopy: "Agent-safe handoff.",
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [
          { attachmentId: "att_save", status: "restored" },
          { attachmentId: "att_cancel", status: "missing" },
          { attachmentId: "att_help", status: "ambiguous" },
          { attachmentId: "att_submit", status: "checking" },
        ],
      },
    })).toMatchObject({ ok: true });
    const server = createLocalBridgeMcpServer(state, { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-receipt-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const expectedPage = {
      pageInstanceId: "chromium-tab:7:frame:0",
      route: "https://app.example.test/settings",
      documentInstanceId: "document-01234567",
    };
    const verify = async (arguments_: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: arguments_,
      });
      expect(result.isError).not.toBe(true);
      return JSON.parse(readText(result));
    };
    try {
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [
          { attachmentId: "att_save", expected: "present" },
          { attachmentId: "att_cancel", expected: "absent" },
        ],
      })).resolves.toMatchObject({
        kind: "ui-attach.page-completion-receipt",
        status: "pass",
        snapshot: { sequence: 4, publishedAt: "2026-07-17T04:30:00.000Z" },
        checks: [
          { attachmentId: "att_save", observed: "restored", outcome: "pass" },
          { attachmentId: "att_cancel", observed: "missing", outcome: "pass" },
        ],
        evidenceSource: "extension-current-page-rebind",
        limitations: [
          "Does not attribute who caused the page change.",
          "Does not prove backend or business completion.",
          "Canonical route identity excludes query and fragment values.",
        ],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "absent" }],
      })).resolves.toMatchObject({
        status: "fail",
        checks: [{ outcome: "fail", reasonCode: "expected_absent_but_restored" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_help", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "ambiguous", outcome: "inconclusive", reasonCode: "observation_ambiguous" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 4,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "baseline_not_advanced" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage: { ...expectedPage, route: "https://app.example.test/account" },
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "page_mismatch" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage: { ...expectedPage, documentInstanceId: "replacement-document" },
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "document_mismatch" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_unknown", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "target_unobserved" }],
      });
      await expect(verify({
        instanceId: "instance-000000000000",
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        snapshot: null,
        checks: [{ observed: "unavailable", reasonCode: "instance_not_found" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:59.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "observation_not_advanced" }],
      });

      const duplicateChecks = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: {
          instanceId: paired.value.instanceId,
          baselineSequence: 3,
          baselineObservedAt: "2026-07-17T04:29:58.000Z",
          expectedPage,
          checks: [
            { attachmentId: "att_save", expected: "present" },
            { attachmentId: "att_save", expected: "absent" },
          ],
        },
      });
      expect(duplicateChecks.isError).toBe(true);

      const unsafeRoute = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: {
          instanceId: paired.value.instanceId,
          baselineSequence: 3,
          baselineObservedAt: "2026-07-17T04:29:58.000Z",
          expectedPage: {
            ...expectedPage,
            route: "https://app.example.test/settings?token=secret",
          },
          checks: [{ attachmentId: "att_save", expected: "present" }],
        },
      });
      expect(unsafeRoute.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rechecks stale and mismatched instance views inside the completion verifier", async () => {
    let view = {
      instanceId: "instance-fedcba987654",
      extensionId: MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
      connectedAt: "2026-07-17T04:29:00.000Z",
      lastSeenAt: "2026-07-17T04:30:00.000Z",
      stale: false,
      snapshot: null,
    };
    const server = createLocalBridgeMcpServer({
      getStatus() { throw new Error("unused"); },
      listInstances() { return []; },
      readInstance() { return { ok: true as const, value: view }; },
    }, { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-receipt-identity-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const arguments_ = {
      instanceId: "instance-0123456789ab",
      baselineSequence: 3,
      baselineObservedAt: "2026-07-17T04:29:58.000Z",
      expectedPage: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
        documentInstanceId: "document-01234567",
      },
      checks: [{ attachmentId: "att_save", expected: "present" }],
    };
    try {
      const mismatched = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: arguments_,
      });
      expect(mismatched.isError).not.toBe(true);
      expect(JSON.parse(readText(mismatched))).toMatchObject({
        status: "inconclusive",
        snapshot: null,
        checks: [{ reasonCode: "instance_identity_mismatch" }],
      });

      view = { ...view, instanceId: arguments_.instanceId, stale: true };
      const stale = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: arguments_,
      });
      expect(stale.isError).not.toBe(true);
      expect(JSON.parse(readText(stale))).toMatchObject({
        status: "inconclusive",
        snapshot: null,
        checks: [{ reasonCode: "instance_stale" }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("resolves an opaque anchor only through MCP-declared workspace roots", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-mcp-source-root-"));
    const source = "export function Panel() {}\n";
    const sourcePath = join(workspaceRoot, "src", "Panel.tsx");
    const buildId = "A".repeat(43);
    const sourceId = "B".repeat(43);
    const sidecar = createSourceMapSidecar(buildId, [{
      sourceId,
      path: "src/Panel.tsx",
      line: 1,
      column: 8,
      tagName: "button",
      componentName: "Panel",
      contentHash: createSourceContentHash(source),
    }]);
    const sidecarPath = join(workspaceRoot, ".ui-attach", "source-map.json");
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`);

    const server = createLocalBridgeMcpServer(createLocalBridgeState());
    const client = new Client(
      { name: "ui-attach-source-test", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(workspaceRoot).href, name: "source fixture" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: {
          sourceAnchor: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.opaque-source-anchor",
            buildId,
            sourceId,
          },
        },
      });
      expect(result.isError, readText(result)).not.toBe(true);
      expect(JSON.parse(readText(result))).toEqual({
        schemaVersion: "0.1.0",
        kind: "ui-attach.source-resolution",
        status: "verified",
        buildId,
        sourceId,
        location: {
          path: "src/Panel.tsx",
          line: 1,
          column: 8,
          tagName: "button",
          componentName: "Panel",
        },
      });
      expect(readText(result)).not.toContain(createSourceContentHash(source));
      expect(readText(result)).not.toContain(workspaceRoot);

      const rejectedRootOverride = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: {
          sourceAnchor: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.opaque-source-anchor",
            buildId,
            sourceId,
          },
          workspaceRoot,
        },
      });
      expect(rejectedRootOverride.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("uses the MCP launch directory only when the client has no roots capability", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-mcp-launch-root-"));
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "ui-attach-mcp-declared-root-"));
    const source = "export function SettingsPanel() {}\n";
    const sourcePath = join(workspaceRoot, "src", "SettingsPanel.tsx");
    const buildId = "C".repeat(43);
    const sourceId = "D".repeat(43);
    const sidecar = createSourceMapSidecar(buildId, [{
      sourceId,
      path: "src/SettingsPanel.tsx",
      line: 1,
      column: 8,
      tagName: "button",
      componentName: "SettingsPanel",
      contentHash: createSourceContentHash(source),
    }]);
    const sidecarPath = join(workspaceRoot, ".ui-attach", "source-map.json");
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`);
    const anchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId,
      sourceId,
    };

    const launchServer = createLocalBridgeMcpServer(createLocalBridgeState(), {
      launchWorkspaceRoot: workspaceRoot,
    });
    const rootsUnavailableClient = new Client({ name: "codex-like-client", version: "0.1.0" });
    const [launchClientTransport, launchServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      launchServer.connect(launchServerTransport),
      rootsUnavailableClient.connect(launchClientTransport),
    ]);
    try {
      const result = await rootsUnavailableClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: anchor },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "verified",
        location: { path: "src/SettingsPanel.tsx" },
      });
    } finally {
      await rootsUnavailableClient.close();
      await launchServer.close();
    }

    const declaredServer = createLocalBridgeMcpServer(createLocalBridgeState(), {
      launchWorkspaceRoot: workspaceRoot,
    });
    const declaredClient = new Client(
      { name: "roots-capable-client", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    declaredClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(unrelatedRoot).href, name: "explicit unrelated root" }],
    }));
    const [declaredClientTransport, declaredServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      declaredServer.connect(declaredServerTransport),
      declaredClient.connect(declaredClientTransport),
    ]);
    try {
      const result = await declaredClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: anchor },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "unavailable",
        reason: "sidecar_missing",
      });
    } finally {
      await declaredClient.close();
      await declaredServer.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(unrelatedRoot, { recursive: true, force: true });
    }
  });

  test("lets a second MCP process read one authenticated loopback owner", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: null,
      attachmentCount: 1,
      agentCopy: "Agent-safe shared handoff.",
    })).toMatchObject({ ok: true });
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const server = createLocalBridgeMcpServer(createHttpLocalBridgeReader(http.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    }), { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-shared-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: "ui_attach_bridge_status", arguments: {} });
      expect(readText(status)).not.toContain("Agent-safe shared handoff");
      expect(readText(status)).not.toContain("ownerIdentity");
      expect(readText(status)).not.toContain(OWNER_IDENTITY.buildHash);
      const list = await client.callTool({ name: "ui_attach_list_instances", arguments: {} });
      expect(readText(list)).not.toContain("Agent-safe shared handoff");
      const exact = await client.callTool({
        name: "ui_attach_read_instance",
        arguments: { instanceId: paired.value.instanceId },
      });
      expect(readText(exact)).toContain("Agent-safe shared handoff");
    } finally {
      await client.close();
      await server.close();
      await http.close();
    }
  });

  test("fails closed on an authenticated owner from a different build", async () => {
    const state = createLocalBridgeState();
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const reader = createHttpLocalBridgeReader(http.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: { ...OWNER_IDENTITY, buildHash: "b".repeat(64) },
    });
    try {
      await expect(reader.getStatus()).rejects.toThrow("invalid status");
    } finally {
      await http.close();
    }
  });

  test("revalidates owner identity after the bound port changes owners", async () => {
    const first = await startLocalBridgeHttpServer(createLocalBridgeState(), {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const reader = createHttpLocalBridgeReader(first.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    await reader.getStatus();
    const port = Number(new URL(first.origin).port);
    await first.close();

    const replacementIdentity = { ...OWNER_IDENTITY, buildHash: "b".repeat(64) };
    const replacement = await startLocalBridgeHttpServer(createLocalBridgeState(), {
      port,
      agentToken: AGENT_TOKEN,
      ownerIdentity: replacementIdentity,
    });
    try {
      await expect(reader.listInstances()).rejects.toThrow("invalid instance list");
      await expect(reader.readInstance("instance-000000000000"))
        .rejects.toThrow("invalid missing-instance response");
    } finally {
      await replacement.close();
    }
  });

  test("fails closed when a proxy cannot authenticate to the owner", async () => {
    const state = createLocalBridgeState();
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const wrongToken = "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
    const server = createLocalBridgeMcpServer(createHttpLocalBridgeReader(http.origin, wrongToken, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    }), { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-denied-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: "ui_attach_bridge_status", arguments: {} });
      expect(status.isError).toBe(true);
      expect(readText(status)).toContain("BRIDGE_OWNER_UNAVAILABLE");
      expect(readText(status)).not.toMatch(/\d{3}-\d{3}/);
    } finally {
      await client.close();
      await server.close();
      await http.close();
    }
  });

  test("does not disclose its credential to or trust a foreign fixed-port listener", async () => {
    let observedAuthorization: string | undefined;
    const foreign = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-status",
        origin: `http://127.0.0.1:${(foreign.address() as { port: number }).port}`,
        pairing: {
          code: "111-222",
          expiresAt: "2026-07-17T04:35:00.000Z",
          attemptsRemaining: 5,
          lockedUntil: null,
        },
        instances: [],
      }));
    });
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const address = foreign.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const reader = createHttpLocalBridgeReader(`http://127.0.0.1:${address.port}`, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    try {
      await expect(reader.getStatus()).rejects.toThrow();
      expect(observedAuthorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => foreign.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("rejects an exact read whose response identifies a different instance", async () => {
    const requested = "instance-000000000000";
    const returned = "instance-111111111111";
    const seenNonces = new Map<string, number>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const requestAuth = verifyLocalBridgeAgentRequestAuth(
        AGENT_TOKEN,
        "GET",
        url.pathname,
        new Headers(init?.headers),
        seenNonces,
      );
      if (!requestAuth) return new Response("denied", { status: 401 });
      const body = `${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-instance",
        ok: true,
        data: {
          instanceId: returned,
          extensionId: MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
          connectedAt: "2026-07-17T04:30:00.000Z",
          lastSeenAt: "2026-07-17T04:30:00.000Z",
          stale: false,
          snapshot: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.local-bridge-snapshot",
            sequence: 1,
            publishedAt: "2026-07-17T04:30:00.000Z",
            page: null,
            attachmentCount: 0,
            agentCopy: null,
          },
        },
      })}\n`;
      return new Response(body, {
        status: 200,
        headers: {
          [RESPONSE_PROOF_HEADER]: createLocalBridgeAgentResponseProof(
            AGENT_TOKEN,
            requestAuth,
            200,
            body,
          ),
        },
      });
    };
    const reader = createHttpLocalBridgeReader(
      "http://127.0.0.1:38471",
      AGENT_TOKEN,
      { expectedOwnerIdentity: OWNER_IDENTITY, fetchImpl },
    );

    await expect(reader.readInstance(requested)).rejects.toThrow();
  });
});

function readText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text tool content.");
  return first.text;
}
