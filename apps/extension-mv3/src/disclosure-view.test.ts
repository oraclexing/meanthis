import { describe, expect, test } from "vitest";
import { isUIAttachment, type UIAttachment } from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import { deriveCaptureRecordDisclosure } from "./disclosure-view";

describe("deriveCaptureRecordDisclosure", () => {
  test("builds an agent-safe view from a cached full debug capture", () => {
    const record = createRecord(createAttachment("full_debug"));

    const result = deriveCaptureRecordDisclosure(record, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.status).toBe("Showing agent_safe view from cached full_debug capture.");
    expect(result.record.attachment.policy.disclosureMode).toBe("agent_safe");
    expect(result.record.pageUrl).toBeNull();
    expect(result.record.summary).toContain("- Policy: agent_safe disclosure");
    expect(result.record.markdown).toContain("- Disclosure Mode: agent_safe");
    expect(result.record.markdown).toContain("### Nearby Text\n  - none");
    expect(result.record.intent).toBe("Make this safer");
    expect(JSON.stringify(result.record)).not.toContain("ada@example.com");
    expect(JSON.stringify(result.record)).not.toContain("sk-test-1234567890");
  });

  test("reports when the cached capture cannot be upgraded", () => {
    const record = createRecord(createAttachment("agent_safe"));

    const result = deriveCaptureRecordDisclosure(record, "full_debug");

    expect(result).toEqual({
      ok: false,
      status: "Capture again with full_debug disclosure to include full debug details.",
    });
  });

  test("recovers a legacy capture whose optional content parts exceed UTF-8 byte limits", () => {
    const attachment = createAttachment("agent_safe");
    attachment.element.contentParts = [{
      kind: "text",
      tagName: "span",
      role: null,
      text: "汉".repeat(6_000),
      accessibleName: null,
    }];
    const record = createRecord(attachment);
    const expectedAttachment = structuredClone(attachment);
    delete expectedAttachment.element.contentParts;
    const expectedResult = deriveCaptureRecordDisclosure(
      createRecord(expectedAttachment),
      "agent_safe",
    );

    expect(isUIAttachment(attachment)).toBe(false);
    expect(isUIAttachment(expectedAttachment)).toBe(true);

    const result = deriveCaptureRecordDisclosure(record, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result).toEqual(expectedResult);
    expect(record.attachment.element.contentParts).toHaveLength(1);
  });

  test("preserves valid optional content parts", () => {
    const attachment = createAttachment("agent_safe");
    attachment.element.contentParts = [{
      kind: "text",
      tagName: "span",
      role: null,
      text: "邀请成员",
      accessibleName: null,
    }];
    const record = createRecord(attachment);
    const originalRecord = structuredClone(record);

    expect(isUIAttachment(attachment)).toBe(true);

    const result = deriveCaptureRecordDisclosure(record, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.record.attachment.element.contentParts).toEqual(
      attachment.element.contentParts,
    );
    expect(record).toEqual(originalRecord);
  });

  test("fails closed when removing legacy content parts does not fix the attachment", () => {
    const attachment = createAttachment("agent_safe");
    attachment.element.contentParts = [{
      kind: "text",
      tagName: "span",
      role: null,
      text: "汉".repeat(6_000),
      accessibleName: null,
    }];
    attachment.element.bbox.width = -1;
    const record = createRecord(attachment);

    expect(isUIAttachment(attachment)).toBe(false);

    const result = deriveCaptureRecordDisclosure(record, "agent_safe");

    expect(result.ok).toBe(false);
  });
});

function createRecord(attachment: UIAttachment): OriginCaptureRecord {
  return {
    origin: "https://example.test",
    pageUrl: attachment.source.url ?? "https://example.test/team",
    pageTitle: "Team ada@example.com",
    attachment,
    intent: "Make this safer",
    markdown: "## Selected UI Element\n\n### Nearby Text\n  - Owner email: ada@example.com",
    summary: "## Agent Quick Summary\n\n- Policy: full_debug disclosure",
    replayAttempts: [
      {
        strategy: "playwright.testId",
        value: 'page.getByTestId("sk-test-1234567890")',
        replayVerified: false,
        uniqueness: null,
        failureReason: "Owner ada@example.com",
        matchCount: 0,
        visible: null,
      },
    ],
    capturedAt: attachment.capturedAt,
  };
}

function createAttachment(disclosureMode: "agent_safe" | "full_debug"): UIAttachment {
  const isFullDebug = disclosureMode === "full_debug";
  return {
    schemaVersion: "0.3.0",
    id: "att_invite-button",
    capturedAt: "2026-07-02T12:40:25.919Z",
    source: {
      kind: "web",
      url: isFullDebug
        ? "https://example.test/team?token=secret#members"
        : "https://example.test/team",
      title: isFullDebug ? "Team ada@example.com" : "Team [redacted:email]",
    },
    element: {
      tagName: "button",
      role: "button",
      text: "Invite",
      accessibleName: "Invite",
      bbox: { x: 32, y: 467, width: 355, height: 40 },
      visible: true,
      enabled: true,
    },
    style: {
      display: "block",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(31, 99, 255)",
    },
    context: {
      parentSummary: "section",
      nearbyText: [
        isFullDebug
          ? "Owner email: ada@example.com API token: sk-test-1234567890"
          : "Owner email: [redacted:email] API token: [redacted:secret]",
      ],
      selectorHints: ["[data-testid=\"invite-button\"]"],
    },
    locatorBundle: {
      primary: {
        strategy: "playwright.role",
        value: "page.getByRole(\"button\", { name: \"Invite\" })",
        confidence: 0.92,
      },
      candidates: [],
      stability: {
        score: 76,
        uniqueness: true,
        replayVerified: true,
        failureReason: null,
      },
    },
    policy: {
      disclosureMode,
      redactionLevel: isFullDebug ? "debug" : "strict",
      actionMode: "suggest_patch",
      allowScreenshot: false,
      allowDomSnippet: false,
      allowNetworkSend: false,
      allowedDomains: ["https://example.test"],
      redactedFields: isFullDebug ? [] : ["context.nearbyText", "source.url"],
      sensitiveHints: ["context.nearbyText", "source.url"],
      includedSensitiveFields: isFullDebug ? ["context.nearbyText", "source.url"] : [],
    },
    artifacts: { screenshotCrop: null, overlayImage: null },
  };
}
