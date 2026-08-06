import type {
  CaptureHubSummary,
  CapturePageRoutingHintV1,
  CapturePromptBundle,
} from "@meanthis/hub-core";
import type { UIAttachment } from "@meanthis/schema";

export interface SessionSummaryOutputV1 {
  schemaVersion: "0.1.0";
  kind: "ui-attach.session-summary";
  ok: true;
  data: CaptureHubSummary;
}

export interface AttachmentOutputV1 {
  schemaVersion: "0.1.0";
  kind: "ui-attach.attachment";
  ok: true;
  data: {
    id: string;
    createdAt: string;
    labels: string[];
    origin: string;
    pageUrl: string | null;
    pageTitle: string | null;
    capturedAt: string;
    routingHint: CapturePageRoutingHintV1 | null;
    attachment: UIAttachment;
    replayAttempts?: unknown[];
  };
}

export interface PromptBundleOutputV1 {
  schemaVersion: "0.1.0";
  kind: "ui-attach.prompt-bundle";
  ok: true;
  data: CapturePromptBundle;
}

export type CliErrorCode =
  | "INVALID_ARGUMENTS"
  | "INPUT_READ_FAILED"
  | "INVALID_JSON"
  | "INVALID_SESSION_FILE"
  | "ATTACHMENT_NOT_FOUND"
  | "DISCLOSURE_UPGRADE_DENIED"
  | "INTERNAL_ERROR";

export interface ErrorOutputV1 {
  schemaVersion: "0.1.0";
  kind: "ui-attach.error";
  ok: false;
  error: {
    code: CliErrorCode;
    message: string;
    issues?: Array<{ path: string; message: string }>;
  };
}
