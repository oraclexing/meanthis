import { UI_ATTACH_LOCAL_BRIDGE_ORIGIN } from "@meanthis/schema";
import type { ExtensionStorageArea } from "./capture-store";

export const DEVELOPMENT_RUNTIME_CONTROL_TYPE =
  "meanthis:development-runtime-control:v1" as const;
export const DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY =
  "meanthis:development-capture-commit-barrier:v1";
export const DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY =
  "meanthis:development-external-bridge-owner-ready:v1";
export const DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY =
  "meanthis:development-annotation-lifecycle-execution-barrier:v1";

const DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_KIND =
  "ui-attach.development-external-bridge-owner-ready";
const DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_MAX_LIFETIME_MS = 120_000;
const DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_HEALTH_TIMEOUT_MS = 5_000;

interface DevelopmentAwareLocalAgentBridgeBootstrapOptions {
  nativeBootstrap(): Promise<void>;
  storage: ExtensionStorageArea;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function createDevelopmentAwareLocalAgentBridgeBootstrap(
  options: DevelopmentAwareLocalAgentBridgeBootstrapOptions,
): () => Promise<void> {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_HEALTH_TIMEOUT_MS;
  return async () => {
    const values = await options.storage.get(DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY);
    if (!Object.hasOwn(values, DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY)) {
      await options.nativeBootstrap();
      return;
    }
    const armed = parseDevelopmentExternalBridgeOwnerReady(
      values[DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY],
      now(),
    );
    await options.storage.remove(DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY);
    if (!armed) {
      throw new Error("Development external bridge owner authorization is invalid.");
    }
    let response: Response;
    try {
      response = await fetchImplementation(`${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}/health`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("Development external bridge owner is unavailable.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Development external bridge owner health response is invalid.");
    }
    if (!response.ok || !isDevelopmentExternalBridgeOwnerHealth(body)) {
      throw new Error("Development external bridge owner health response is invalid.");
    }
  };
}

function parseDevelopmentExternalBridgeOwnerReady(
  value: unknown,
  now: number,
): { expiresAt: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    keys.some((key) => typeof key !== "string") ||
    !["expiresAt", "kind", "origin", "schemaVersion"].every((key) => keys.includes(key))
  ) return null;
  const record: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    record[key] = descriptor.value;
  }
  const expiresAtMs = typeof record.expiresAt === "string"
    ? Date.parse(record.expiresAt)
    : Number.NaN;
  if (
    record.schemaVersion !== "0.1.0" ||
    record.kind !== DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_KIND ||
    record.origin !== UI_ATTACH_LOCAL_BRIDGE_ORIGIN ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== record.expiresAt ||
    expiresAtMs <= now ||
    expiresAtMs - now > DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_MAX_LIFETIME_MS
  ) return null;
  return { expiresAt: record.expiresAt };
}

function isDevelopmentExternalBridgeOwnerHealth(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    (keys.length !== 3 && keys.length !== 4)
  ) return false;
  const record: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    record[key] = descriptor.value;
  }
  const expected = ["kind", "ok", "schemaVersion"];
  if (keys.length === 4) expected.push("sharing");
  return expected.every((key) => Object.hasOwn(record, key)) &&
    record.schemaVersion === "0.1.0" &&
    record.kind === "ui-attach.local-bridge-health" &&
    record.ok === true &&
    (keys.length === 3 || record.sharing === "owner-proxy-v1");
}

type DevelopmentCaptureCommitBarrier =
  | {
      version: 1;
      nonce: string;
      phase: "pre_write" | "post_write";
      state: "armed";
    }
  | {
      version: 1;
      nonce: string;
      phase: "pre_write" | "post_write";
      state: "entered" | "released";
      operationId: string;
    };

type DevelopmentAnnotationLifecycleExecutionBarrier =
  | {
      version: 1;
      nonce: string;
      phase: "after-approved-before-mutation" | "after-canonical-before-commit-marker" |
        "after-committed-before-reconcile-ack";
      state: "armed";
    }
  | {
      version: 1;
      nonce: string;
      phase: "after-approved-before-mutation" | "after-canonical-before-commit-marker" |
        "after-committed-before-reconcile-ack";
      state: "entered" | "released";
      operationId: string;
    };

export function createDevelopmentAnnotationLifecycleExecutionGate(options: {
  storage: ExtensionStorageArea;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}) {
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const waitAtPhase = async (
    phase: DevelopmentAnnotationLifecycleExecutionBarrier["phase"],
    operationId: string,
  ): Promise<void> => {
    const armed = await readAnnotationLifecycleExecutionBarrier(options.storage);
    if (!armed) return;
    if (armed.state !== "armed" || armed.phase !== phase) {
      const phases: readonly DevelopmentAnnotationLifecycleExecutionBarrier["phase"][] = [
        "after-approved-before-mutation",
        "after-canonical-before-commit-marker",
        "after-committed-before-reconcile-ack",
      ];
      if (armed.state === "armed" && phases.indexOf(phase) < phases.indexOf(armed.phase)) return;
      throw new Error("Development annotation lifecycle execution barrier is stale.");
    }
    const entered: DevelopmentAnnotationLifecycleExecutionBarrier = {
      version: 1,
      nonce: armed.nonce,
      phase,
      state: "entered",
      operationId,
    };
    await options.storage.set({
      [DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY]: entered,
    });
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const current = await readAnnotationLifecycleExecutionBarrier(options.storage);
      if (
        current?.state === "released" && current.nonce === entered.nonce &&
        current.phase === phase && current.operationId === operationId
      ) {
        await options.storage.remove(DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY);
        return;
      }
      if (
        !current || current.state !== "entered" || current.nonce !== entered.nonce ||
        current.phase !== phase || current.operationId !== operationId
      ) {
        throw new Error("Development annotation lifecycle execution barrier authority changed.");
      }
      await delay(10);
    }
    throw new Error("Development annotation lifecycle execution barrier timed out.");
  };
  return {
    afterApproved(operationId: string): Promise<void> {
      return waitAtPhase("after-approved-before-mutation", operationId);
    },
    afterCanonicalCommit(operationId: string): Promise<void> {
      return waitAtPhase("after-canonical-before-commit-marker", operationId);
    },
    afterCommitted(operationId: string): Promise<void> {
      return waitAtPhase("after-committed-before-reconcile-ack", operationId);
    },
  };
}

async function readAnnotationLifecycleExecutionBarrier(
  storage: ExtensionStorageArea,
): Promise<DevelopmentAnnotationLifecycleExecutionBarrier | null> {
  const values = await storage.get(DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY);
  if (!Object.hasOwn(values, DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY)) return null;
  const parsed = parseAnnotationLifecycleExecutionBarrier(
    values[DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY],
  );
  if (!parsed) throw new Error("Development annotation lifecycle execution barrier schema is invalid.");
  return parsed;
}

function parseAnnotationLifecycleExecutionBarrier(
  value: unknown,
): DevelopmentAnnotationLifecycleExecutionBarrier | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return null;
  const expectedLength = ownKeys.includes("operationId") ? 5 : 4;
  if (ownKeys.length !== expectedLength) return null;
  const record: Record<string, unknown> = {};
  for (const key of ownKeys as string[]) {
    if (!["version", "nonce", "phase", "state", "operationId"].includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) return null;
    record[key] = descriptor.value;
  }
  if (
    record.version !== 1 || typeof record.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(record.nonce) ||
    (record.phase !== "after-approved-before-mutation" &&
      record.phase !== "after-canonical-before-commit-marker" &&
      record.phase !== "after-committed-before-reconcile-ack") ||
    (record.state !== "armed" && record.state !== "entered" && record.state !== "released")
  ) return null;
  if (record.state === "armed") return !Object.hasOwn(record, "operationId")
    ? record as DevelopmentAnnotationLifecycleExecutionBarrier
    : null;
  return typeof record.operationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.operationId)
    ? record as DevelopmentAnnotationLifecycleExecutionBarrier
    : null;
}

export function createDevelopmentCaptureCommitGate(options: {
  storage: ExtensionStorageArea;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}) {
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const waitAtPhase = async (
    phase: DevelopmentCaptureCommitBarrier["phase"],
    operationId: string,
  ): Promise<void> => {
    const armed = await readCaptureCommitBarrier(options.storage);
    if (!armed) return;
    if (armed.state !== "armed") {
      throw new Error("Development capture commit barrier is not armed.");
    }
    if (armed.phase !== phase) {
      if (phase === "pre_write" && armed.phase === "post_write") return;
      throw new Error("Development capture commit barrier phase is stale.");
    }
    const entered: DevelopmentCaptureCommitBarrier = {
      version: 1,
      nonce: armed.nonce,
      phase,
      state: "entered",
      operationId,
    };
    await options.storage.set({ [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: entered });
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const current = await readCaptureCommitBarrier(options.storage);
      if (
        current?.state === "released" &&
        current.nonce === entered.nonce &&
        current.phase === phase &&
        current.operationId === operationId
      ) {
        await options.storage.remove(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY);
        return;
      }
      if (
        !current ||
        current.state !== "entered" ||
        current.nonce !== entered.nonce ||
        current.phase !== phase ||
        current.operationId !== operationId
      ) {
        throw new Error("Development capture commit barrier authority changed.");
      }
      await delay(10);
    }
    throw new Error("Development capture commit barrier timed out.");
  };
  return {
    async beforeWrite(operationId: string): Promise<void> {
      await waitAtPhase("pre_write", operationId);
    },
    async afterWrite(operationId: string): Promise<void> {
      await waitAtPhase("post_write", operationId);
    },
  };
}

async function readCaptureCommitBarrier(
  storage: ExtensionStorageArea,
): Promise<DevelopmentCaptureCommitBarrier | null> {
  const values = await storage.get(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY);
  if (!Object.hasOwn(values, DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY)) return null;
  const parsed = parseCaptureCommitBarrier(values[DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]);
  if (!parsed) throw new Error("Development capture commit barrier schema is invalid.");
  return parsed;
}

function parseCaptureCommitBarrier(value: unknown): DevelopmentCaptureCommitBarrier | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return null;
  const record: Record<string, unknown> = {};
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    record[key] = descriptor.value;
  }
  const keys = ownKeys as string[];
  const expectedKeys = record.state === "armed"
    ? ["nonce", "phase", "state", "version"]
    : ["nonce", "operationId", "phase", "state", "version"];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key)) ||
    record.version !== 1 ||
    typeof record.nonce !== "string" ||
    record.nonce.length < 16 ||
    record.nonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(record.nonce) ||
    (record.phase !== "pre_write" && record.phase !== "post_write") ||
    (record.state !== "armed" && record.state !== "entered" && record.state !== "released") ||
    (record.state !== "armed" && (
      typeof record.operationId !== "string" ||
      record.operationId.length < 1 ||
      record.operationId.length > 128 ||
      record.operationId.trim() !== record.operationId ||
      /[\u0000-\u001f\u007f]/u.test(record.operationId)
    ))
  ) return null;
  return record.state === "armed"
    ? {
        version: 1,
        nonce: record.nonce,
        phase: record.phase,
        state: "armed",
      }
    : {
        version: 1,
        nonce: record.nonce,
        operationId: record.operationId as string,
        phase: record.phase,
        state: record.state,
      };
}

interface DevelopmentRuntimeControlMessageBase {
  targetBuildId: string;
  token: string;
  type: typeof DEVELOPMENT_RUNTIME_CONTROL_TYPE;
}

export type DevelopmentRuntimeControlMessage =
  | (DevelopmentRuntimeControlMessageBase & {
      action: "ping";
    })
  | (DevelopmentRuntimeControlMessageBase & {
      action: "diagnostics" | "reload";
      observedBuildId: string;
    });

interface DevelopmentRuntimeControlRuntime {
  onMessageExternal: {
    addListener(
      listener: (
        message: unknown,
        sender: { url?: string },
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
  reload(): void;
}

interface DevelopmentRuntimeControlOptions {
  buildId: string;
  eventTarget?: {
    addEventListener(type: string, listener: (event: unknown) => void): void;
  };
  expectedSenderUrl: string;
  now?: () => string;
  queueTask?: (task: () => void) => void;
  runtime: DevelopmentRuntimeControlRuntime;
  token: string;
}

export function createDevelopmentRuntimeControl(
  options: DevelopmentRuntimeControlOptions,
) {
  const queueTask = options.queueTask ?? queueMicrotask;
  const now = options.now ?? (() => new Date().toISOString());
  const events: Array<{
    at: string;
    kind: "error" | "unhandledrejection";
    message: string;
  }> = [];
  return {
    register(): void {
      if (options.token.length === 0 || options.buildId.length === 0) return;
      const capture = (kind: "error" | "unhandledrejection") => (event: unknown) => {
        events.push({
          at: now(),
          kind,
          message: readDiagnosticMessage(event, kind, options.token),
        });
        if (events.length > 32) events.splice(0, events.length - 32);
      };
      options.eventTarget?.addEventListener("error", capture("error"));
      options.eventTarget?.addEventListener(
        "unhandledrejection",
        capture("unhandledrejection"),
      );
      options.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
        if (
          sender.url !== options.expectedSenderUrl ||
          !isDevelopmentRuntimeControlMessage(message) ||
          message.token !== options.token ||
          (message.action !== "ping" && message.observedBuildId !== options.buildId) ||
          (message.action === "diagnostics" && message.targetBuildId !== options.buildId) ||
          (message.action === "reload" && message.targetBuildId === options.buildId)
        ) {
          return;
        }
        sendResponse({
          buildId: options.buildId,
          ...(message.action === "diagnostics" ? {
            events: events.map((event) => ({ ...event })),
          } : {}),
          ok: true,
        });
        if (message.action === "reload") {
          queueTask(() => options.runtime.reload());
        }
      });
    },
  };
}

export function registerDevelopmentRuntimeControl(): void {
  createDevelopmentRuntimeControl({
    buildId: __MEANTHIS_EXTENSION_DEV_BUILD_ID__,
    eventTarget: globalThis as unknown as {
      addEventListener(type: string, listener: (event: unknown) => void): void;
    },
    expectedSenderUrl: "http://127.0.0.1:41731/reload",
    runtime: chrome.runtime as unknown as DevelopmentRuntimeControlRuntime,
    token: __MEANTHIS_EXTENSION_DEV_RELOAD_TOKEN__,
  }).register();
}

function isDevelopmentRuntimeControlMessage(
  value: unknown,
): value is DevelopmentRuntimeControlMessage {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    }
    const message = value as Record<string, unknown>;
    const expectedKeys = message.action === "ping"
      ? ["action", "targetBuildId", "token", "type"]
      : ["action", "observedBuildId", "targetBuildId", "token", "type"];
    if (
      keys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !keys.includes(key)) ||
      message.type !== DEVELOPMENT_RUNTIME_CONTROL_TYPE ||
      !isBoundedString(message.targetBuildId, 128) ||
      !isBoundedString(message.token, 128)
    ) {
      return false;
    }
    if (message.action === "ping") return true;
    return (message.action === "diagnostics" || message.action === "reload") &&
      isBoundedString(message.observedBuildId, 128);
  } catch {
    return false;
  }
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function readDiagnosticMessage(
  event: unknown,
  kind: "error" | "unhandledrejection",
  token: string,
): string {
  let candidate: unknown;
  try {
    if (event !== null && typeof event === "object") {
      const record = event as Record<string, unknown>;
      candidate = kind === "error"
        ? record.message ?? record.error
        : record.reason;
    }
  } catch {}
  if (candidate instanceof Error) candidate = candidate.message;
  const message = String(candidate ?? "Unknown runtime failure.")
    .replaceAll(token, "[redacted]")
    .slice(0, 512)
    .trim();
  return message || "Unknown runtime failure.";
}
