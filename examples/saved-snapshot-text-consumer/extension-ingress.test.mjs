import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  deriveStoredSessionHandoff,
  serializeSavedSnapshotPromptBundleJson,
} from "../../apps/extension-mv3/src/session-file.ts";
import {
  acceptSavedSnapshotTextConsumerBundleJson,
} from "./index.mjs";

describe("saved snapshot extension-to-consumer ingress", () => {
  test("binds the exact structured artifact produced from a retained MV3 session", () => {
    const file = JSON.parse(readFileSync(
      new URL(
        "../../apps/extension-mv3/fixtures/two-element.capture-session.json",
        import.meta.url,
      ),
      "utf8",
    ));
    const handoff = deriveStoredSessionHandoff(file, file.session.origin, "epoch-1");

    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    const copiedJson = serializeSavedSnapshotPromptBundleJson(handoff.value.bundle);
    const acceptance = acceptSavedSnapshotTextConsumerBundleJson(copiedJson);
    expect(acceptance).not.toBeNull();
    if (acceptance === null) return;
    const { acceptedContext, consumerReceipt } = acceptance;

    expect(acceptedContext).toMatchObject({
      kind: "ui-attach.saved-snapshot-attachment-context",
      disclosureMode: "agent_safe",
      attachmentCount: 2,
      attachmentIds: handoff.value.bundle.attachmentIds,
      authority: {
        status: "not_rechecked",
        origin: file.session.origin,
        routingPolicy: "omitted",
        controlPolicy: "live_recheck_and_user_confirmation_required",
      },
    });
    expect(acceptedContext.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(consumerReceipt).toMatchObject({
      kind: "ui-attach.saved-snapshot-public-consumer-receipt",
      consumerContextSha256: acceptedContext.contentSha256,
      consumerAttachmentCount: 2,
      consumerAuthorityStatus: "not_rechecked",
      consumerRoutingPolicy: "omitted",
      consumerStatus: "accepted",
      modelFieldsUsedCount: 0,
    });
    expect(copiedJson).not.toContain("pageInstanceId");
    expect(copiedJson).not.toContain('"tabId"');
    expect(copiedJson).not.toContain('"frameId"');
  });
});
