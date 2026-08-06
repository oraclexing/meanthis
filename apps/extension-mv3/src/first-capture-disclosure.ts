import type { ExtensionStorageArea } from "./capture-store";

export const FIRST_CAPTURE_DISCLOSURE_ID = "ui-attach.first-capture.v3";
export const FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY = "ui-attach:first-capture-disclosure:v1";

export interface FirstCaptureDisclosureStore {
  isAcknowledged(): Promise<boolean>;
  acknowledge(): Promise<void>;
}

export function createFirstCaptureDisclosureStore(options: {
  storage: ExtensionStorageArea;
  disclosureId?: string;
}): FirstCaptureDisclosureStore {
  const disclosureId = options.disclosureId ?? FIRST_CAPTURE_DISCLOSURE_ID;
  return {
    async isAcknowledged() {
      const values = await options.storage.get(FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY);
      const record = values[FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY];
      return isAcknowledgedDisclosure(record, disclosureId);
    },
    async acknowledge() {
      await options.storage.set({
        [FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY]: {
          disclosureId,
          acknowledged: true,
        },
      });
    },
  };
}

function isAcknowledgedDisclosure(
  value: unknown,
  disclosureId: string,
): value is { disclosureId: string; acknowledged: true } {
  return typeof value === "object" &&
    value !== null &&
    "disclosureId" in value &&
    value.disclosureId === disclosureId &&
    "acknowledged" in value &&
    value.acknowledged === true;
}
