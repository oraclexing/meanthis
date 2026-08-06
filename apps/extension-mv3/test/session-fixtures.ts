import type { CaptureSessionFileV1 } from "@meanthis/hub-core";
import type { UIAttachment, UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { OriginCaptureRecord } from "../src/capture-store";

const ORIGIN = "https://app.example.test";
const FIRST_CAPTURED_AT = "2026-07-11T10:00:00.000Z";
const SECOND_CAPTURED_AT = "2026-07-11T10:02:00.000Z";

export function createAttachment(
  disclosureMode: UIAttachmentDisclosureMode,
  overrides: Partial<UIAttachment> = {},
): UIAttachment {
  const fullDebug = disclosureMode === "full_debug";
  const attachment: UIAttachment = {
    schemaVersion: "0.3.0",
    id: "att_save",
    capturedAt: FIRST_CAPTURED_AT,
    source: {
      kind: "web",
      url: `${ORIGIN}/settings`,
      title: "Settings",
    },
    element: {
      tagName: "button",
      role: "button",
      text: "Save changes",
      accessibleName: "Save changes",
      bbox: { x: 10, y: 20, width: 100, height: 36 },
      visible: true,
      enabled: true,
    },
    style: {
      display: "block",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(31, 99, 255)",
    },
    context: {
      parentSummary: "section Settings",
      nearbyText: fullDebug ? ["Signed in as ada@example.com"] : [],
      selectorHints: fullDebug ? ["token=sk-test-1234567890"] : [],
    },
    locatorBundle: {
      primary: {
        strategy: "playwright.role",
        value: 'page.getByRole("button", { name: "Save changes" })',
        confidence: 0.92,
        notes: "Stable accessible name",
      },
      candidates: [
        {
          strategy: "css",
          value: '[data-testid="save"]',
          confidence: 0.8,
        },
      ],
      stability: {
        score: 76,
        uniqueness: true,
        replayVerified: true,
        failureReason: null,
        verifiedBy: "playwright.role",
        verifiedValue: 'page.getByRole("button", { name: "Save changes" })',
      },
    },
    policy: {
      disclosureMode,
      redactionLevel: fullDebug ? "debug" : "strict",
      actionMode: "suggest_patch",
      allowScreenshot: false,
      allowDomSnippet: false,
      allowNetworkSend: false,
      allowedDomains: [ORIGIN],
      redactedFields: [],
      sensitiveHints: [],
      includedSensitiveFields: fullDebug
        ? ["context.nearbyText", "context.selectorHints"]
        : [],
    },
    artifacts: {
      screenshotCrop: null,
      overlayImage: null,
    },
  };

  return { ...attachment, ...overrides };
}

export function createCaptureRecord(
  id: string,
  name: string,
  disclosureMode: UIAttachmentDisclosureMode = "agent_safe",
): OriginCaptureRecord {
  const capturedAt = id === "save" ? FIRST_CAPTURED_AT : SECOND_CAPTURED_AT;
  const attachment = createAttachment(disclosureMode, {
    id: `att_${id}`,
    capturedAt,
  });
  attachment.element = {
    ...attachment.element,
    text: name,
    accessibleName: name,
  };
  attachment.locatorBundle = {
    ...attachment.locatorBundle,
    primary: attachment.locatorBundle.primary
      ? {
          ...attachment.locatorBundle.primary,
          value: `page.getByRole("button", { name: "${name}" })`,
        }
      : null,
  };

  return {
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/settings`,
    pageTitle: "Settings",
    attachment,
    intent: `Update ${name}`,
    markdown: `# ${name}`,
    summary: name,
    replayAttempts: [],
    capturedAt,
    tabId: 1,
    frameId: 0,
  };
}

export function createSessionFile(
  records: OriginCaptureRecord[] = [
    createCaptureRecord("save", "Save changes"),
    createCaptureRecord("cancel", "Cancel"),
  ],
): CaptureSessionFileV1 {
  const createdAt = records[0]?.capturedAt ?? FIRST_CAPTURED_AT;
  const updatedAt = records.at(-1)?.capturedAt ?? createdAt;

  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.capture-session",
    session: {
      id: "session-1",
      title: "Settings",
      createdAt,
      updatedAt,
      origin: ORIGIN,
      attachments: records.map((record, index) => ({
        id: record.attachment.id,
        createdAt: record.capturedAt,
        labels: [String.fromCharCode("A".charCodeAt(0) + index)],
        sourceRecord: {
          origin: record.origin,
          pageUrl: record.pageUrl,
          pageTitle: record.pageTitle,
          attachment: record.attachment,
          intent: record.intent,
          ...(record.replayAttempts !== undefined
            ? { replayAttempts: record.replayAttempts }
            : {}),
          capturedAt: record.capturedAt,
          ...(record.tabId !== undefined ? { tabId: record.tabId } : {}),
          ...(record.frameId !== undefined ? { frameId: record.frameId } : {}),
          ...(record.routeChain !== undefined
            ? { routeChain: record.routeChain.map((route) => ({ ...route })) }
            : {}),
        },
      })),
    },
  };
}

export function reorderEveryKnownRecord(file: CaptureSessionFileV1): CaptureSessionFileV1 {
  return reorderValue(file) as CaptureSessionFileV1;
}

function reorderValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reorderValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reorderValue(item)]),
  );
}
