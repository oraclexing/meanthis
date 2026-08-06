import { createCaptureHub } from "@meanthis/hub-core";
import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";

export type CaptureRecordDisclosureResult =
  | {
      ok: true;
      record: OriginCaptureRecord;
      status: string;
    }
  | {
      ok: false;
      status: string;
    };

export function deriveCaptureRecordDisclosure(
  record: OriginCaptureRecord,
  disclosureMode: UIAttachmentDisclosureMode,
): CaptureRecordDisclosureResult {
  const hub = createCaptureHub();
  const session = hub.createSession({
    id: "extension-panel-preview",
    title: record.pageTitle,
    origin: record.origin,
  });
  const added = hub.addAttachment(session.id, record);
  if (!added.ok) {
    return { ok: false, status: added.error };
  }

  const result = hub.getAttachment(session.id, record.attachment.id, { disclosureMode });
  if (!result.ok) {
    return {
      ok: false,
      status: `Capture again with ${disclosureMode} disclosure to include ${formatDisclosureModeLabel(
        disclosureMode,
      )} details.`,
    };
  }

  const attachment = result.record.attachment;
  return {
    ok: true,
    status:
      attachment.policy.disclosureMode === record.attachment.policy.disclosureMode
        ? "Capture ready."
        : `Showing ${attachment.policy.disclosureMode} view from cached ${record.attachment.policy.disclosureMode} capture.`,
    record: result.record as OriginCaptureRecord,
  };
}

function formatDisclosureModeLabel(disclosureMode: UIAttachmentDisclosureMode): string {
  return disclosureMode.replaceAll("_", " ");
}
