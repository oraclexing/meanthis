import { describe, expect, test } from "vitest";
import {
  UI_ATTACHMENT_COMPUTED_STYLE_FIELDS,
  type UIAttachment,
} from "@meanthis/schema";
import {
  CAPTURE_SESSION_FILE_SCHEMA_VERSION,
  CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2,
  CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3,
  hydrateCaptureSessionFile,
  isCaptureSessionAnnotationLifecycleV3,
  isCaptureSessionFileV1,
  isCaptureSessionFileV2,
  isCaptureSessionFileV3,
  parseCaptureSessionFile,
  serializeCaptureSessionFile,
  validateCaptureSessionFile,
  type CaptureSessionFileV3,
  type CaptureSessionFileV2,
  type CaptureSessionFileV1,
} from "./index";

describe("capture session file", () => {
  test("accepts the current annotation identity schema without rewriting item identity or timestamps", () => {
    const input = createAnnotationSessionFile();
    const before = structuredClone(input);

    const validation = validateCaptureSessionFile(input);
    const hydration = hydrateCaptureSessionFile(input);

    expect(CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2).toBe("0.2.0");
    expect(validation).toEqual({ ok: true, file: input });
    expect(hydration.ok).toBe(true);
    if (!hydration.ok) return;
    expect(hydration.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    })).toEqual(expect.objectContaining({
      ok: true,
      item: expect.objectContaining({
        annotationId: "annotation-identity-a",
        createdAt: "2026-07-10T10:00:00.000Z",
        updatedAt: "2026-07-10T10:01:00.000Z",
      }),
    }));
    expect(input).toEqual(before);
  });

  test("keeps legacy V1 readable without synthesizing a permanent annotation identity", () => {
    const input = createSessionFile();

    const validation = validateCaptureSessionFile(input);
    const hydration = hydrateCaptureSessionFile(input);

    expect(validation).toEqual({ ok: true, file: input });
    expect(hydration.ok).toBe(true);
    if (!hydration.ok) return;
    const item = hydration.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    });
    expect(item.ok).toBe(true);
    if (!item.ok) return;
    expect(item.item).not.toHaveProperty("annotationId");
    expect(item.item).not.toHaveProperty("updatedAt");
  });

  test("fails closed when annotation identity fields do not match the declared schema revision", () => {
    const missingIdentity = createAnnotationSessionFile() as unknown as Record<string, unknown>;
    delete ((missingIdentity.session as CaptureSessionFileV2["session"]).attachments[0] as {
      annotationId?: string;
    }).annotationId;
    const missingUpdatedAt = createAnnotationSessionFile() as unknown as Record<string, unknown>;
    delete ((missingUpdatedAt.session as CaptureSessionFileV2["session"]).attachments[0] as {
      updatedAt?: string;
    }).updatedAt;
    const backwardUpdatedAt = createAnnotationSessionFile();
    backwardUpdatedAt.session.attachments[0].updatedAt = "2026-07-10T09:59:59.999Z";
    const laterThanSession = createAnnotationSessionFile();
    laterThanSession.session.attachments[0].updatedAt = "2026-07-10T10:02:00.001Z";
    const legacyWithIdentity = createSessionFile() as CaptureSessionFileV1 & {
      session: { attachments: Array<{ annotationId?: string }> };
    };
    legacyWithIdentity.session.attachments[0].annotationId = "must-not-be-accepted-as-v1";

    expect(validateCaptureSessionFile(missingIdentity)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({
        path: "session.attachments[0].annotationId",
      })]),
    }));
    expect(validateCaptureSessionFile(legacyWithIdentity)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({
        path: "session.attachments[0].[unknownField:0]",
      })]),
    }));
    expect(validateCaptureSessionFile(missingUpdatedAt)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({
        path: "session.attachments[0].updatedAt",
      })]),
    }));
    expect(validateCaptureSessionFile(backwardUpdatedAt)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([{
        path: "session.attachments[0].updatedAt",
        message: "Expected item updatedAt not to precede createdAt.",
      }]),
    }));
    expect(validateCaptureSessionFile(laterThanSession)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([{
        path: "session.attachments[0].updatedAt",
        message: "Expected item updatedAt not to exceed session updatedAt.",
      }]),
    }));
  });

  test.each([
    ["malformed", "annotation id with spaces", "Expected an opaque ASCII annotation id up to 128 characters."],
    ["over-bound", "a".repeat(129), "Expected an opaque ASCII annotation id up to 128 characters."],
    ["duplicate", "annotation-identity-b", "Duplicate annotation id."],
  ])("rejects %s annotation identity without reflecting its value", (_case, annotationId, message) => {
    const input = createAnnotationSessionFile();
    input.session.attachments[0].annotationId = annotationId;

    const result = validateCaptureSessionFile(input);

    const expectedPath = _case === "duplicate"
      ? "session.attachments[1].annotationId"
      : "session.attachments[0].annotationId";
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([{
        path: expectedPath,
        message,
      }]),
    }));
    expect(JSON.stringify(result)).not.toContain(annotationId);
  });

  test.each([
    ["open", () => createLifecycleSessionFile("open")],
    ["resolved", () => createLifecycleSessionFile("resolved")],
  ] as const)("accepts a V3 %s lifecycle and preserves it during hydration", (_state, create) => {
    const input = create();
    const before = structuredClone(input);

    expect(CAPTURE_SESSION_FILE_SCHEMA_VERSION).toBe(CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3);
    expect(validateCaptureSessionFile(input)).toEqual({ ok: true, file: input });
    expect(isCaptureSessionFileV3(input)).toBe(true);
    expect(isCaptureSessionAnnotationLifecycleV3(input.session.attachments[0].annotationLifecycle)).toBe(true);

    const hydrated = hydrateCaptureSessionFile(input);

    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    const attachment = hydrated.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    });
    expect(attachment).toEqual(expect.objectContaining({
      ok: true,
      item: expect.objectContaining({
        annotationId: "annotation-identity-a",
        annotationLifecycle: input.session.attachments[0].annotationLifecycle,
        createdAt: "2026-07-10T10:00:00.000Z",
        updatedAt: "2026-07-10T10:01:00.000Z",
      }),
    }));
    expect(input).toEqual(before);
  });

  test("keeps V1 and V2 type guards and serialization on their declared versions", () => {
    const legacy = createSessionFile();
    const identity = createAnnotationSessionFile();

    expect(isCaptureSessionFileV1(legacy)).toBe(true);
    expect(isCaptureSessionFileV2(identity)).toBe(true);
    expect(isCaptureSessionFileV3(legacy)).toBe(false);
    expect(isCaptureSessionFileV3(identity)).toBe(false);

    for (const input of [legacy, identity]) {
      const serialized = serializeCaptureSessionFile(input);
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) continue;
      expect(serialized.value.file.schemaVersion).toBe(input.schemaVersion);
      expect(serialized.value.file).toEqual(input);
      expect(serialized.value.file.session.attachments[0]).not.toHaveProperty("annotationLifecycle");
      expect(parseCaptureSessionFile(serialized.value.text)).toEqual({
        ok: true,
        value: serialized.value.file,
      });
    }
  });

  test.each([
    ["missing", (file: CaptureSessionFileV3) => {
      delete (file.session.attachments[0] as unknown as Record<string, unknown>).annotationLifecycle;
    }],
    ["own undefined", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0] as unknown as Record<string, unknown>).annotationLifecycle = undefined;
    }],
    ["null", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0] as unknown as Record<string, unknown>).annotationLifecycle = null;
    }],
    ["malformed", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "pending",
        resolvedAt: null,
      } as unknown as CaptureSessionFileV3["session"]["attachments"][number]["annotationLifecycle"];
    }],
    ["extra field", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0].annotationLifecycle as unknown as Record<string, unknown>).reason = "done";
    }],
    ["invalid open time", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "open",
        resolvedAt: "2026-07-10T10:00:30.000Z",
      };
    }],
    ["invalid resolved state", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "resolved",
        resolvedAt: null,
      };
    }],
    ["malformed resolved time", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "resolved",
        resolvedAt: "not-a-date",
      };
    }],
    ["resolved before createdAt", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "resolved",
        resolvedAt: "2026-07-10T09:59:59.999Z",
      };
    }],
    ["resolved after updatedAt", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "resolved",
        resolvedAt: "2026-07-10T10:01:00.001Z",
      };
    }],
    ["extended-year over-bound", (file: CaptureSessionFileV3) => {
      file.session.attachments[0].annotationLifecycle = {
        state: "resolved",
        resolvedAt: "+010000-01-01T00:00:00.000Z",
      };
    }],
  ] as const)("rejects V3 lifecycle %s", (_name, mutate) => {
    const input = createLifecycleSessionFile("resolved");
    mutate(input);

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    expect(isCaptureSessionFileV3(input)).toBe(false);
  });

  test("rejects extended-year V3 session timestamps while retaining V2 acceptance", () => {
    const v3 = createLifecycleSessionFile("open");
    v3.session.updatedAt = "+010000-01-01T00:00:00.000Z";
    expect(validateCaptureSessionFile(v3).ok).toBe(false);

    const v2 = createAnnotationSessionFile();
    v2.session.updatedAt = "+010000-01-01T00:00:00.000Z";
    v2.session.attachments[0].updatedAt = "+010000-01-01T00:00:00.000Z";
    expect(validateCaptureSessionFile(v2).ok).toBe(true);
  });

  test("serializes and parses V3 canonical bytes without migration", () => {
    const input = createLifecycleSessionFile("resolved");
    const before = structuredClone(input);

    const serialized = serializeCaptureSessionFile(input);

    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.text).toBe(`${JSON.stringify(serialized.value.file, null, 2)}\n`);
    expect(serialized.value.byteLength).toBe(
      new TextEncoder().encode(serialized.value.text).byteLength,
    );
    expect(serialized.value.file.schemaVersion).toBe("0.3.0");
    const serializedV3 = serialized.value.file as CaptureSessionFileV3;
    expect(serializedV3.session.attachments[0].annotationLifecycle).toEqual(
      input.session.attachments[0].annotationLifecycle,
    );
    expect(parseCaptureSessionFile(serialized.value.text)).toEqual({
      ok: true,
      value: serialized.value.file,
    });
    expect(parseCaptureSessionFile(JSON.stringify(input))).toEqual({
      ok: false,
      issues: [{ path: "", message: "Expected canonical capture session JSON bytes." }],
    });
    expect(input).toEqual(before);
  });

  test("hydrates a valid session file without changing ids or timestamps", () => {
    const input = createSessionFile();
    const before = structuredClone(input);

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe("session-1");
    expect(result.hub.summarizeSession(result.sessionId)).toEqual(
      expect.objectContaining({
        ok: true,
        sessionId: "session-1",
        attachmentCount: 2,
        lastUpdatedAt: "2026-07-10T10:02:00.000Z",
      }),
    );
    expect(input).toEqual(before);
  });

  test("preserves a hydrated session when creating the next session", () => {
    const input = createSessionFile();
    input.session.id = "session-2";

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.hub.createSession();
    expect(created.id).toBe("session-3");
    expect(result.hub.listSessions()).toHaveLength(2);
    expect(result.hub.summarizeSession("session-2")).toEqual(
      expect.objectContaining({ ok: true, attachmentCount: 2 }),
    );
  });

  test("accepts and preserves an exact opaque source anchor", () => {
    const input = createSessionFile();
    input.session.attachments[0].sourceRecord.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sourceId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    };

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachment = result.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    });
    expect(attachment).toEqual(expect.objectContaining({
      ok: true,
      record: expect.objectContaining({
        attachment: expect.objectContaining({
          sourceAnchor: input.session.attachments[0].sourceRecord.attachment.sourceAnchor,
        }),
      }),
    }));
  });

  test("accepts and preserves an exact element-relative selection point", () => {
    const input = createSessionFile();
    const selectionPoint = {
      kind: "element_relative_pointer" as const,
      xRatio: 0.25,
      yRatio: 0.75,
    };
    input.session.attachments[0].sourceRecord.attachment.selectionPoint = selectionPoint;
    const before = structuredClone(input);

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachment = result.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    });
    expect(attachment).toEqual(expect.objectContaining({
      ok: true,
      record: expect.objectContaining({
        attachment: expect.objectContaining({ selectionPoint }),
      }),
    }));
    expect(input).toEqual(before);
  });

  test("rejects an unknown selection point field before hydration", () => {
    const input = createSessionFile();
    input.session.attachments[0].sourceRecord.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.75,
      clientX: 32,
    } as unknown as UIAttachment["selectionPoint"];

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "session.attachments[0].sourceRecord.attachment.selectionPoint.[unknownField:0]",
      message: "Unknown field.",
    });
  });

  test("accepts and preserves structured element content parts", () => {
    const input = createSessionFile("agent_safe");
    input.session.attachments[0].sourceRecord.attachment.element.contentParts = [
      {
        kind: "link",
        tagName: "a",
        role: "link",
        text: "Documentation",
        accessibleName: "Open documentation",
      },
      {
        kind: "time",
        tagName: "time",
        role: null,
        text: "8 minutes ago",
        accessibleName: null,
      },
    ];

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachment = result.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    });
    expect(attachment).toEqual(expect.objectContaining({
      ok: true,
      record: expect.objectContaining({
        attachment: expect.objectContaining({
          element: expect.objectContaining({
            contentParts: input.session.attachments[0].sourceRecord.attachment.element.contentParts,
          }),
        }),
      }),
    }));
  });

  test("accepts and preserves a canonical embedded-frame pathname", () => {
    const input = createSessionFile();
    input.session.attachments[0].sourceRecord.attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://frame.example.test",
      framePathname: "/redirect/start",
      dominantViewport: true,
    };

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachment = result.hub.getAttachment("session-1", "att_save", {
      disclosureMode: "agent_safe",
    });
    expect(attachment).toEqual(expect.objectContaining({
      ok: true,
      record: expect.objectContaining({
        attachment: expect.objectContaining({
          boundary: input.session.attachments[0].sourceRecord.attachment.boundary,
        }),
      }),
    }));
  });

  test("rejects unknown fields inside an opaque source anchor", () => {
    const input = createSessionFile();
    const sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sourceId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      file: "src/Settings.tsx",
    };
    input.session.attachments[0].sourceRecord.attachment.sourceAnchor =
      sourceAnchor as UIAttachment["sourceAnchor"];

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "session.attachments[0].sourceRecord.attachment.sourceAnchor.[unknownField:0]",
      message: "Unknown field.",
    });
  });

  test.each([
    ["attachment", (attachment: UIAttachment) => setUnknownField(attachment)],
    ["attachment.source", (attachment: UIAttachment) => setUnknownField(attachment.source)],
    ["attachment.element", (attachment: UIAttachment) => setUnknownField(attachment.element)],
    [
      "attachment.element.contentParts[0]",
      (attachment: UIAttachment) => {
        attachment.element.contentParts = [{
          kind: "text",
          tagName: "p",
          role: null,
          text: "Visible text",
          accessibleName: null,
        }];
        setUnknownField(attachment.element.contentParts[0]!);
      },
    ],
    ["attachment.element.bbox", (attachment: UIAttachment) => setUnknownField(attachment.element.bbox)],
    ["attachment.style", (attachment: UIAttachment) => setUnknownField(attachment.style)],
    ["attachment.context", (attachment: UIAttachment) => setUnknownField(attachment.context)],
    ["attachment.locatorBundle", (attachment: UIAttachment) => setUnknownField(attachment.locatorBundle)],
    [
      "attachment.locatorBundle.primary",
      (attachment: UIAttachment) => setUnknownField(attachment.locatorBundle.primary),
    ],
    [
      "attachment.locatorBundle.candidates[0]",
      (attachment: UIAttachment) => {
        attachment.locatorBundle.candidates.push({
          strategy: "css",
          value: "button",
          confidence: 0.5,
        });
        setUnknownField(attachment.locatorBundle.candidates[0]);
      },
    ],
    [
      "attachment.locatorBundle.stability",
      (attachment: UIAttachment) => setUnknownField(attachment.locatorBundle.stability),
    ],
    ["attachment.policy", (attachment: UIAttachment) => setUnknownField(attachment.policy)],
    ["attachment.artifacts", (attachment: UIAttachment) => setUnknownField(attachment.artifacts)],
  ])("rejects an unknown field in %s", (relativePath, mutate) => {
    const input = createSessionFile();
    mutate(input.session.attachments[0].sourceRecord.attachment);

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(
      `session.attachments[0].sourceRecord.${relativePath}.[unknownField:0]`,
    );
  });

  test("reports multiple unknown fields with deterministic safe ordinals", () => {
    const input = createSessionFile();
    const element = input.session.attachments[0].sourceRecord.attachment
      .element as unknown as Record<string, unknown>;
    element["first-private-key"] = "first private value";
    element["sk-test-1234567890"] = "token-secret-1234567890";

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const unknownIssues = result.issues.filter(
      (issue) => issue.message === "Unknown field.",
    );
    expect(unknownIssues).toEqual([
      {
        path: "session.attachments[0].sourceRecord.attachment.element.[unknownField:0]",
        message: "Unknown field.",
      },
      {
        path: "session.attachments[0].sourceRecord.attachment.element.[unknownField:1]",
        message: "Unknown field.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("first-private-key");
    expect(JSON.stringify(result)).not.toContain("sk-test-1234567890");
    expect(JSON.stringify(result)).not.toContain("token-secret-1234567890");
  });

  test("rejects unknown attachment data before hydration can expose a selected output", () => {
    const input = createSessionFile();
    setUnknownField(
      input.session.attachments[0].sourceRecord.attachment.element,
      "sk-test-1234567890",
      "token-secret-1234567890",
    );

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    expect("hub" in result).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "session.attachments[0].sourceRecord.attachment.element.[unknownField:0]",
      message: "Unknown field.",
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-1234567890");
    expect(JSON.stringify(result)).not.toContain("token-secret-1234567890");
  });

  test.each([
    ["root", (file: CaptureSessionFileV1) => file as unknown as object, "[unknownField:0]"],
    ["session", (file: CaptureSessionFileV1) => file.session, "session.[unknownField:0]"],
    [
      "item",
      (file: CaptureSessionFileV1) => file.session.attachments[0],
      "session.attachments[0].[unknownField:0]",
    ],
    [
      "source record",
      (file: CaptureSessionFileV1) => file.session.attachments[0].sourceRecord,
      "session.attachments[0].sourceRecord.[unknownField:0]",
    ],
  ])("rejects an unknown field on the %s before hydration", (_kind, select, expectedPath) => {
    const input = createSessionFile();
    setUnknownField(select(input), "privatePayload", "sk-test-outer-secret");

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    expect("hub" in result).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ path: expectedPath, message: "Unknown field." });
    expect(JSON.stringify(result)).not.toContain("privatePayload");
    expect(JSON.stringify(result)).not.toContain("sk-test-outer-secret");
  });

  test("accepts the existing 26-attachment product limit", () => {
    const input = createSessionFile();
    input.session.attachments = Array.from({ length: 26 }, (_, index) =>
      createItem(
        `att_budget_${index}`,
        `Target ${index}`,
        String.fromCharCode(65 + index),
        "2026-07-10T10:01:00.000Z",
        "full_debug",
      ));

    expect(validateCaptureSessionFile(input).ok).toBe(true);
  });

  test.each([
    [
      "attachment count",
      (file: CaptureSessionFileV1) => {
        file.session.attachments = Array.from({ length: 27 }, (_, index) => {
          const item = createItem(
            `att_budget_${index}`,
            `Target ${index}`,
            "A",
            "2026-07-10T10:01:00.000Z",
            "full_debug",
          );
          item.labels = [];
          return item;
        });
      },
    ],
    [
      "nested collection length",
      (file: CaptureSessionFileV1) => {
        file.session.attachments[0].sourceRecord.attachment.context.nearbyText =
          Array.from({ length: 257 }, () => "bounded text");
      },
    ],
    [
      "individual string bytes",
      (file: CaptureSessionFileV1) => {
        file.session.attachments[0].sourceRecord.intent = "x".repeat(1_048_577);
      },
    ],
    [
      "object key count",
      (file: CaptureSessionFileV1) => {
        file.session.attachments[0].sourceRecord.replayAttempts = [
          Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, index])),
        ];
      },
    ],
    [
      "total serialized bytes",
      (file: CaptureSessionFileV1) => {
        file.session.attachments[0].sourceRecord.replayAttempts =
          Array.from({ length: 5 }, () => "x".repeat(250_000));
      },
    ],
    [
      "value node count",
      (file: CaptureSessionFileV1) => {
        file.session.attachments[0].sourceRecord.replayAttempts =
          Array.from({ length: 256 }, () => Array.from({ length: 256 }, () => null));
      },
    ],
  ])("rejects capture sessions over the %s budget", (_kind, mutate) => {
    const input = createSessionFile();
    mutate(input);

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.length).toBeLessThanOrEqual(100);
  });

  test("caps cumulative validation issues", () => {
    const input = createSessionFile();
    input.session.attachments[0].labels = Array.from(
      { length: 101 },
      (_, index) => `invalid-label-${index}`,
    );

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(100);
  });

  test("rejects cyclic and over-depth values without recursive serialization", () => {
    const cyclicInput = createSessionFile();
    const cyclicAttempt: Record<string, unknown> = {};
    cyclicAttempt.self = cyclicAttempt;
    cyclicInput.session.attachments[0].sourceRecord.replayAttempts = [cyclicAttempt];

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 33; depth += 1) nested = [nested];
    const deepInput = createSessionFile();
    deepInput.session.attachments[0].sourceRecord.replayAttempts = [nested];

    expect(validateCaptureSessionFile(cyclicInput)).toEqual({
      ok: false,
      issues: [{ path: "", message: "Capture session exceeds validation limits." }],
    });
    expect(validateCaptureSessionFile(deepInput)).toEqual({
      ok: false,
      issues: [{ path: "", message: "Capture session exceeds validation limits." }],
    });
  });

  test("rejects accessor properties without invoking page-controlled getters", () => {
    const input = createSessionFile();
    const attempt: Record<string, unknown> = {};
    let getterInvoked = false;
    Object.defineProperty(attempt, "secret", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "sk-test-accessor-secret";
      },
    });
    input.session.attachments[0].sourceRecord.replayAttempts = [attempt];

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    expect(getterInvoked).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-test-accessor-secret");
  });

  test.each([
    [
      "root session",
      "session",
      (file: CaptureSessionFileV1) => {
        const inherited = file.session;
        delete (file as unknown as Record<string, unknown>).session;
        return inherited;
      },
    ],
    [
      "session attachments",
      "attachments",
      (file: CaptureSessionFileV1) => {
        const inherited = file.session.attachments;
        delete (file.session as unknown as Record<string, unknown>).attachments;
        return inherited;
      },
    ],
    [
      "item sourceRecord",
      "sourceRecord",
      (file: CaptureSessionFileV1) => {
        const item = file.session.attachments[0];
        const inherited = item.sourceRecord;
        delete (item as unknown as Record<string, unknown>).sourceRecord;
        return inherited;
      },
    ],
    [
      "source record attachment",
      "attachment",
      (file: CaptureSessionFileV1) => {
        const sourceRecord = file.session.attachments[0].sourceRecord;
        const inherited = sourceRecord.attachment;
        delete (sourceRecord as unknown as Record<string, unknown>).attachment;
        return inherited;
      },
    ],
  ])("rejects an inherited %s getter without invoking it", (_kind, field, mutate) => {
    const input = createSessionFile();
    const inherited = mutate(input);
    let getterInvoked = false;
    Object.defineProperty(Object.prototype, field, {
      configurable: true,
      get() {
        getterInvoked = true;
        return inherited;
      },
    });

    try {
      const result = validateCaptureSessionFile(input);

      expect(result.ok).toBe(false);
      expect(getterInvoked).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[field];
    }
  });

  test("budgets the same proxy descriptor value that enters the safe validation snapshot", () => {
    const input = createSessionFile();
    const oversizedSession = structuredClone(input.session);
    oversizedSession.attachments[0].sourceRecord.intent = "x".repeat(1_048_577);
    let sessionDescriptorReads = 0;
    const changingInput = new Proxy(input as unknown as Record<string, unknown>, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "session" || !descriptor || !("value" in descriptor)) {
          return descriptor;
        }
        sessionDescriptorReads += 1;
        return sessionDescriptorReads === 1
          ? descriptor
          : { ...descriptor, value: oversizedSession };
      },
    });

    const result = validateCaptureSessionFile(changingInput);

    expect(result).toEqual({
      ok: false,
      issues: [{ path: "", message: "Capture session exceeds the byte limit." }],
    });
    expect(sessionDescriptorReads).toBeGreaterThanOrEqual(2);
  });

  test("requires a canonical attachment capture timestamp", () => {
    const input = createSessionFile();
    input.session.attachments[0].sourceRecord.attachment.capturedAt =
      "2026-07-10T10:01:00Z";

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(
      "session.attachments[0].sourceRecord.attachment.capturedAt",
    );
  });

  test("accepts a canonical top-page-to-frame route chain", () => {
    const input = createSessionFile();
    const sourceRecord = input.session.attachments[0].sourceRecord;
    sourceRecord.frameId = 5;
    sourceRecord.routeChain = [
      { origin: "https://docs.example.test", pathname: "/mcp/reference" },
      { origin: "https://shell.example.test", pathname: "/companion" },
      { origin: "https://app.example.test", pathname: "/settings" },
    ];

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
  });

  test.each([
    [
      "query data",
      [{ origin: "https://app.example.test", pathname: "/settings?token=secret" }],
      0,
    ],
    [
      "a terminal route different from pageUrl",
      [{ origin: "https://app.example.test", pathname: "/account" }],
      0,
    ],
    [
      "a top-level depth for an embedded frame",
      [{ origin: "https://app.example.test", pathname: "/settings" }],
      4,
    ],
  ] as const)("rejects route chains containing %s", (_name, routeChain, frameId) => {
    const input = createSessionFile();
    const sourceRecord = input.session.attachments[0].sourceRecord;
    sourceRecord.frameId = frameId;
    sourceRecord.routeChain = routeChain.map((route) => ({ ...route }));

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => (
      issue.path === "session.attachments[0].sourceRecord.routeChain" ||
      issue.path.startsWith("session.attachments[0].sourceRecord.routeChain[")
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  test("requires frame identity when a route chain is present", () => {
    const input = createSessionFile();
    const sourceRecord = input.session.attachments[0].sourceRecord;
    delete sourceRecord.frameId;
    sourceRecord.routeChain = [
      { origin: "https://app.example.test", pathname: "/settings" },
    ];

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "session.attachments[0].sourceRecord.routeChain",
      message: "Expected the route chain to include a valid frameId.",
    });
  });

  test("requires every attachment policy domain to equal the canonical session origin", () => {
    const input = createSessionFile();
    input.session.attachments[0].sourceRecord.attachment.policy.allowedDomains.push(
      "https://admin.example.test",
    );

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "session.attachments[0].sourceRecord.attachment.policy.allowedDomains[1]",
      message: 'Expected origin "https://app.example.test".',
    });
  });

  test.each([
    ["redactedFields", "ada@example.com"],
    ["sensitiveHints", "sk-test-1234567890"],
    ["includedSensitiveFields", "token-secret-1234567890"],
  ] as const)("rejects arbitrary policy audit metadata in %s", (field, value) => {
    const input = createSessionFile();
    input.session.attachments[0].sourceRecord.attachment.policy[field] = [value];

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: `session.attachments[0].sourceRecord.attachment.policy.${field}[0]`,
      message: "Expected a known disclosure field path.",
    });
  });

  test("accepts every disclosure field path emitted by extraction and Hub replay", () => {
    const input = createSessionFile();
    const policy = input.session.attachments[0].sourceRecord.attachment.policy;
    policy.sensitiveHints = [
      "attachment.id",
      "source.url",
      "source.title",
      "element.tagName",
      "element.role",
      "element.text",
      "element.accessibleName",
      "style.display",
      "style.color",
      "style.backgroundColor",
      ...UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.map((field) => `style.${field}`),
      "context.parentSummary",
      "context.nearbyText",
      "context.selectorHints",
      "locatorBundle.candidates",
      "locatorBundle.notes",
      "locatorBundle.stability.failureReason",
      "locatorBundle.stability.verifiedValue",
      "artifacts.screenshotCrop",
      "artifacts.overlayImage",
      "record.replayAttempts",
    ];

    const result = hydrateCaptureSessionFile(input);

    expect(result.ok).toBe(true);
  });

  test("preserves optional bounded computed style facts through canonical hydration", () => {
    const input = createSessionFile();
    Object.assign(input.session.attachments[0].sourceRecord.attachment.style, {
      position: "relative",
      boxSizing: "border-box",
      width: "100px",
      height: "36px",
      margin: "4px",
      padding: "6px 8px",
      gap: "10px",
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      overflowX: "visible",
      overflowY: "hidden",
      fontSize: "14px",
      fontWeight: "600",
      lineHeight: "20px",
      borderRadius: "8px",
    });

    const result = serializeCaptureSessionFile(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.file.session.attachments[0].sourceRecord.attachment.style).toMatchObject({
      position: "relative",
      padding: "6px 8px",
      gap: "10px",
      fontSize: "14px",
      borderRadius: "8px",
    });
  });

  test("recomputes derived text and preserves disclosure non-upgrade behavior", () => {
    const result = hydrateCaptureSessionFile(createSessionFile("agent_safe"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const safe = result.hub.getAttachment(result.sessionId, "att_save");
    expect(safe.ok).toBe(true);
    if (!safe.ok) return;
    expect(safe.record.summary).toContain("agent_safe disclosure");
    expect(safe.record.markdown).toContain("Save changes");

    expect(
      result.hub.getAttachment(result.sessionId, "att_save", {
        disclosureMode: "full_debug",
      }),
    ).toEqual({
      ok: false,
      error:
        "Cannot derive full_debug disclosure from agent_safe capture. Capture again with full_debug disclosure.",
    });
  });

  test("returns ordered field-path issues for invalid files", () => {
    const input = createSessionFile();
    input.schemaVersion = "9.0.0" as "0.1.0";
    input.session.attachments[1].id = input.session.attachments[0].id;
    input.session.attachments[1].sourceRecord.origin = "https://admin.example.test";
    input.session.attachments[1].sourceRecord.capturedAt = "not-a-date";

    const result = validateCaptureSessionFile(input);

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: "schemaVersion", message: 'Expected "0.1.0", "0.2.0", or "0.3.0".' },
        {
          path: "session.attachments[1].id",
          message: 'Duplicate attachment id "att_save".',
        },
        {
          path: "session.attachments[1].id",
          message: 'Expected attachment id "att_cancel" or a numeric deduplication suffix.',
        },
        {
          path: "session.attachments[1].sourceRecord.origin",
          message: 'Expected origin "https://app.example.test".',
        },
        {
          path: "session.attachments[1].sourceRecord.capturedAt",
          message: "Expected a canonical UTC ISO date-time string.",
        },
      ],
    });
  });

  test.each([
    ["malformed attachment", "session.attachments[0].sourceRecord.attachment"],
    ["non-canonical session origin", "session.origin"],
    ["cross-origin page URL", "session.attachments[0].sourceRecord.pageUrl"],
    [
      "cross-origin attachment source URL",
      "session.attachments[0].sourceRecord.attachment.source.url",
    ],
    ["non-array replay attempts", "session.attachments[0].sourceRecord.replayAttempts"],
    ["empty item id", "session.attachments[0].id"],
  ])("reports the exact path for %s", (kind, expectedPath) => {
    const input = createSessionFile();
    switch (kind) {
      case "malformed attachment":
        (input.session.attachments[0].sourceRecord as { attachment: unknown }).attachment = {};
        break;
      case "non-canonical session origin":
        input.session.origin = "https://app.example.test/";
        break;
      case "cross-origin page URL":
        input.session.attachments[0].sourceRecord.pageUrl = "https://admin.example.test/settings";
        break;
      case "cross-origin attachment source URL":
        input.session.attachments[0].sourceRecord.attachment.source.url =
          "https://admin.example.test/settings";
        break;
      case "non-array replay attempts":
        (input.session.attachments[0].sourceRecord as { replayAttempts?: unknown }).replayAttempts = {};
        break;
      case "empty item id":
        input.session.attachments[0].id = "";
        break;
    }

    const result = validateCaptureSessionFile(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(expectedPath);
  });

  test("rejects persisted derived text at the source-record paths", () => {
    const input = createSessionFile();
    const record = input.session.attachments[0].sourceRecord as unknown as Record<string, unknown>;
    record.markdown = "persisted markdown";
    record.summary = "persisted summary";

    const result = validateCaptureSessionFile(input);

    expect(result).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        {
          path: "session.attachments[0].sourceRecord.markdown",
          message: "Derived markdown must not be persisted in a session file.",
        },
        {
          path: "session.attachments[0].sourceRecord.summary",
          message: "Derived summary must not be persisted in a session file.",
        },
      ]),
    });
  });

  test.each([
    ["sensitive session id", (file: CaptureSessionFileV1) => (file.session.id = "session-sk-test-1234567890")],
    [
      "unmatched session title",
      (file: CaptureSessionFileV1) => (file.session.title = "Custom metadata title"),
    ],
    [
      "sensitive item id",
      (file: CaptureSessionFileV1) => (file.session.attachments[0].id = "sk-test-1234567890"),
    ],
    [
      "non-numeric item suffix",
      (file: CaptureSessionFileV1) => (file.session.attachments[0].id = "att_save-secret"),
    ],
    [
      "out-of-range label",
      (file: CaptureSessionFileV1) => (file.session.attachments[0].labels = ["AA"]),
    ],
    [
      "duplicate label",
      (file: CaptureSessionFileV1) => (file.session.attachments[1].labels = ["A"]),
    ],
  ])("rejects %s metadata", (_kind, mutate) => {
    const input = createSessionFile();
    mutate(input);

    expect(validateCaptureSessionFile(input).ok).toBe(false);
  });
});

function createSessionFile(
  disclosureMode: "agent_safe" | "developer_diagnostic" | "full_debug" = "full_debug",
): CaptureSessionFileV1 {
  const createdAt = "2026-07-10T10:00:00.000Z";
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.capture-session",
    session: {
      id: "session-1",
      title: "Settings",
      createdAt,
      updatedAt: "2026-07-10T10:02:00.000Z",
      origin: "https://app.example.test",
      attachments: [
        createItem("att_save", "Save changes", "A", createdAt, disclosureMode),
        createItem(
          "att_cancel",
          "Cancel",
          "B",
          "2026-07-10T10:02:00.000Z",
          disclosureMode,
        ),
      ],
    },
  };
}

function createAnnotationSessionFile(): CaptureSessionFileV2 {
  const legacy = createSessionFile();
  return {
    ...legacy,
    schemaVersion: "0.2.0",
    session: {
      ...legacy.session,
      attachments: legacy.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `annotation-identity-${index === 0 ? "a" : "b"}`,
        updatedAt: index === 0 ? "2026-07-10T10:01:00.000Z" : item.createdAt,
      })),
    },
  };
}

function createLifecycleSessionFile(
  state: "open" | "resolved",
): CaptureSessionFileV3 {
  const identity = createAnnotationSessionFile();
  return {
    ...identity,
    schemaVersion: CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3,
    session: {
      ...identity.session,
      attachments: identity.session.attachments.map((item, index) => ({
        ...item,
        annotationLifecycle: {
          state,
          resolvedAt: state === "resolved"
            ? index === 0
              ? "2026-07-10T10:00:30.000Z"
              : "2026-07-10T10:02:00.000Z"
            : null,
        },
      })),
    },
  };
}

function createItem(
  id: string,
  text: string,
  label: string,
  capturedAt: string,
  disclosureMode: "agent_safe" | "developer_diagnostic" | "full_debug",
): CaptureSessionFileV1["session"]["attachments"][number] {
  const attachment: UIAttachment = {
    schemaVersion: "0.3.0",
    id,
    capturedAt,
    source: {
      kind: "web",
      url: "https://app.example.test/settings",
      title: "Settings",
    },
    element: {
      tagName: "button",
      role: "button",
      text,
      accessibleName: text,
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
      nearbyText: [],
      selectorHints: [`[data-testid="${id}"]`, "button"],
    },
    locatorBundle: {
      primary: {
        strategy: "playwright.role",
        value: `page.getByRole("button", { name: "${text}" })`,
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
      redactionLevel: disclosureMode === "full_debug" ? "debug" : "strict",
      actionMode: "suggest_patch",
      allowScreenshot: false,
      allowDomSnippet: false,
      allowNetworkSend: false,
      allowedDomains: ["https://app.example.test"],
      redactedFields: [],
      sensitiveHints: [],
      includedSensitiveFields: [],
    },
    artifacts: { screenshotCrop: null, overlayImage: null },
  };

  return {
    id,
    createdAt: capturedAt,
    labels: [label],
    sourceRecord: {
      origin: "https://app.example.test",
      pageUrl: "https://app.example.test/settings",
      pageTitle: "Settings",
      attachment,
      intent: "",
      replayAttempts: [],
      capturedAt,
      tabId: 1,
      frameId: 0,
    },
  };
}

function setUnknownField(
  value: object | null,
  field = "unexpected",
  secret = "unexpected data",
): void {
  if (value === null) {
    throw new Error("Expected a record fixture.");
  }
  (value as Record<string, unknown>)[field] = secret;
}
