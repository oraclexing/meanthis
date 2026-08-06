import { describe, expect, it } from "vitest";
import {
  createAttachmentId,
  isUIAttachmentSourceAnchor,
  isUIAttachment,
  UI_ATTACHMENT_SCHEMA_VERSION,
  UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
  type UIAttachment,
} from "./index";

const validAttachment: UIAttachment = {
  schemaVersion: UI_ATTACHMENT_SCHEMA_VERSION,
  id: "att_test",
  capturedAt: "2026-07-02T00:00:00.000Z",
  source: {
    kind: "web",
    url: "https://example.test/settings",
    title: "Settings",
  },
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
    selectorHints: ["button[type=\"submit\"]", "[data-testid=\"save-button\"]"],
  },
  locatorBundle: {
    primary: {
      strategy: "playwright.role",
      value: "page.getByRole(\"button\", { name: \"Save changes\" })",
      confidence: 0.92,
    },
    candidates: [
      {
        strategy: "playwright.testId",
        value: "page.getByTestId(\"save-button\")",
        confidence: 0.86,
      },
      {
        strategy: "css",
        value: "[data-testid=\"save-button\"]",
        confidence: 0.68,
        notes: "engineering fallback",
      },
    ],
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
    redactedFields: [],
    sensitiveHints: [],
    includedSensitiveFields: [],
  },
  artifacts: {
    screenshotCrop: null,
    overlayImage: null,
  },
};

describe("UIAttachment schema", () => {
  it("accepts a valid attachment", () => {
    expect(isUIAttachment(validAttachment)).toBe(true);
  });

  it("accepts an exact opaque source anchor without treating it as verified", () => {
    const sourceAnchor = {
      schemaVersion: UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
      kind: "ui-attach.opaque-source-anchor",
      buildId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sourceId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    } as const;

    expect(isUIAttachmentSourceAnchor(sourceAnchor)).toBe(true);
    expect(isUIAttachment({ ...validAttachment, sourceAnchor })).toBe(true);
  });

  it("rejects malformed or path-bearing source anchors", () => {
    expect(
      isUIAttachmentSourceAnchor({
        schemaVersion: UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
        kind: "ui-attach.opaque-source-anchor",
        buildId: "too-short",
        sourceId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      }),
    ).toBe(false);
    expect(
      isUIAttachmentSourceAnchor({
        schemaVersion: UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
        kind: "ui-attach.opaque-source-anchor",
        buildId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sourceId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        file: "src/Settings.tsx",
        line: 42,
      }),
    ).toBe(false);
    expect(
      isUIAttachment({
        ...validAttachment,
        sourceAnchor: {
          schemaVersion: UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
          kind: "ui-attach.opaque-source-anchor",
          buildId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          sourceId: "not-base64url",
        },
      }),
    ).toBe(false);
  });

  it("accepts viewport-relative bounds with negative positions", () => {
    const partiallyOffscreen = {
      ...validAttachment,
      element: {
        ...validAttachment.element,
        bbox: { x: -12, y: -8, width: 80, height: 32 },
      },
    };

    expect(isUIAttachment(partiallyOffscreen)).toBe(true);
  });

  it("accepts an exact embedded-frame boundary and rejects unsafe frame origins", () => {
    const boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://docs.example.test",
      framePathname: "/reference",
      dominantViewport: true,
    } as const;

    expect(isUIAttachment({ ...validAttachment, boundary })).toBe(true);
    expect(
      isUIAttachment({
        ...validAttachment,
        boundary: {
          ...boundary,
          frameOrigin: "https://docs.example.test/private?token=secret",
        },
      }),
    ).toBe(false);
    expect(
      isUIAttachment({
        ...validAttachment,
        boundary: { ...boundary, unexpected: "page data" },
      }),
    ).toBe(false);
    expect(
      isUIAttachment({
        ...validAttachment,
        boundary: { ...boundary, framePathname: "/private?token=secret" },
      }),
    ).toBe(false);
    expect(
      isUIAttachment({
        ...validAttachment,
        boundary: { ...boundary, originRelation: "opaque_or_unavailable" },
      }),
    ).toBe(false);
    expect(
      isUIAttachment({
        ...validAttachment,
        boundary: { ...boundary, frameOrigin: null },
      }),
    ).toBe(false);
  });

  it("rejects malformed bounds", () => {
    const malformed = {
      ...validAttachment,
      element: {
        ...validAttachment.element,
        bbox: { x: 10, y: 20, width: -1, height: 32 },
      },
    };

    expect(isUIAttachment(malformed)).toBe(false);
  });

  it("rejects malformed locator confidence", () => {
    const malformed = {
      ...validAttachment,
      locatorBundle: {
        ...validAttachment.locatorBundle,
        primary: {
          ...validAttachment.locatorBundle.primary,
          confidence: 1.2,
        },
      },
    };

    expect(isUIAttachment(malformed)).toBe(false);
  });

  it("rejects unknown policy modes", () => {
    const malformed = {
      ...validAttachment,
      policy: {
        ...validAttachment.policy,
        redactionLevel: "unsafe",
      },
    };

    expect(isUIAttachment(malformed)).toBe(false);
  });

  it("rejects unknown disclosure modes", () => {
    const malformed = {
      ...validAttachment,
      policy: {
        ...validAttachment.policy,
        disclosureMode: "raw",
      },
    };

    expect(isUIAttachment(malformed)).toBe(false);
  });

  it("validates optional replay matched locator metadata", () => {
    expect(
      isUIAttachment({
        ...validAttachment,
        locatorBundle: {
          ...validAttachment.locatorBundle,
          stability: {
            ...validAttachment.locatorBundle.stability,
            replayVerified: true,
            uniqueness: true,
            verifiedBy: "css",
            verifiedValue: "#send",
          },
        },
      }),
    ).toBe(true);

    expect(
      isUIAttachment({
        ...validAttachment,
        locatorBundle: {
          ...validAttachment.locatorBundle,
          stability: {
            ...validAttachment.locatorBundle.stability,
            verifiedBy: "role",
            verifiedValue: "#send",
          },
        },
      }),
    ).toBe(false);
  });

  it("creates stable attachment id prefixes", () => {
    expect(createAttachmentId("abc123")).toBe("att_abc123");
  });
});
