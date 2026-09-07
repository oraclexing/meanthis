import { describe, expect, test, vi } from "vitest";
import {
  createDevelopmentAnnotationLifecycleExecutionGate,
  createDevelopmentAwareLocalAgentBridgeBootstrap,
  createDevelopmentCaptureCommitGate,
  createDevelopmentRuntimeControl,
  DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY,
  DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY,
  DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY,
  type DevelopmentRuntimeControlMessage,
} from "./development-runtime-control.development";
import type { ExtensionStorageArea } from "./capture-store";

function createStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ExtensionStorageArea = {
    async get(keys) {
      const requested = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(requested.flatMap((key) =>
        values.has(key) ? [[key, values.get(key)]] : []
      ));
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) values.delete(key);
    },
  };
  return { storage, values };
}

async function waitForBarrierState(
  values: Map<string, unknown>,
  state: string,
  key = DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = values.get(key);
    if (
      typeof value === "object" && value !== null &&
      (value as Record<string, unknown>).state === state
    ) return value as Record<string, unknown>;
    await Promise.resolve();
  }
  throw new Error(`Barrier did not reach ${state}.`);
}

function createRuntime() {
  let listener:
    | ((
        message: unknown,
        sender: { url?: string },
        sendResponse: (response: unknown) => void,
      ) => boolean | void)
    | undefined;
  const reload = vi.fn();
  return {
    runtime: {
      onMessageExternal: {
        addListener(candidate: typeof listener) {
          listener = candidate;
        },
      },
      reload,
    },
    dispatch(message: unknown, senderUrl = "http://127.0.0.1:41731/reload") {
      const responses: unknown[] = [];
      const keepAlive = listener?.(message, { url: senderUrl }, (response) => {
        responses.push(response);
      });
      return { keepAlive, responses };
    },
    reload,
  };
}

function createEventTarget() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    dispatch(type: string, event: unknown) {
      listeners.get(type)?.(event);
    },
    eventTarget: {
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
    },
  };
}

const ping = (
  targetBuildId = "build-3",
  token = "test-token",
): DevelopmentRuntimeControlMessage => ({
  action: "ping",
  targetBuildId,
  token,
  type: "meanthis:development-runtime-control:v1",
});

const reload = (
  observedBuildId = "build-2",
  targetBuildId = "build-3",
): DevelopmentRuntimeControlMessage => ({
  action: "reload",
  observedBuildId,
  targetBuildId,
  token: "test-token",
  type: "meanthis:development-runtime-control:v1",
});

const externalBridgeOwnerReady = (expiresAt = "2026-08-20T14:01:00.000Z") => ({
  schemaVersion: "0.1.0",
  kind: "ui-attach.development-external-bridge-owner-ready",
  origin: "http://127.0.0.1:38471",
  expiresAt,
});

describe("development-aware local bridge bootstrap", () => {
  test("keeps the normal native bootstrap when no QA authorization exists", async () => {
    const fake = createStorage();
    const nativeBootstrap = vi.fn(async () => undefined);
    const fetch = vi.fn();

    await createDevelopmentAwareLocalAgentBridgeBootstrap({
      nativeBootstrap,
      storage: fake.storage,
      fetch,
    })();

    expect(nativeBootstrap).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("consumes one exact QA authorization and proves the fixed owner health", async () => {
    const fake = createStorage({
      [DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY]: externalBridgeOwnerReady(),
    });
    const nativeBootstrap = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-health",
      ok: true,
      sharing: "owner-proxy-v1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await createDevelopmentAwareLocalAgentBridgeBootstrap({
      nativeBootstrap,
      storage: fake.storage,
      fetch,
      now: () => Date.parse("2026-08-20T14:00:00.000Z"),
    })();

    expect(nativeBootstrap).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:38471/health", expect.objectContaining({
      method: "GET",
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
    expect(fake.values.has(DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY)).toBe(false);
  });

  test("fails closed and consumes malformed or expired QA authorization", async () => {
    const values = [
      { ...externalBridgeOwnerReady(), extra: true },
      externalBridgeOwnerReady("2026-08-20T13:59:59.999Z"),
      externalBridgeOwnerReady("2026-08-20T14:02:00.001Z"),
    ];
    for (const value of values) {
      const fake = createStorage({ [DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY]: value });
      const nativeBootstrap = vi.fn(async () => undefined);
      const fetch = vi.fn();
      await expect(createDevelopmentAwareLocalAgentBridgeBootstrap({
        nativeBootstrap,
        storage: fake.storage,
        fetch,
        now: () => Date.parse("2026-08-20T14:00:00.000Z"),
      })()).rejects.toThrow("Development external bridge owner authorization is invalid.");
      expect(nativeBootstrap).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(fake.values.has(DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY)).toBe(false);
    }
  });

  test("does not invoke accessors in the QA authorization or health response", async () => {
    const authorizationGetter = vi.fn(() => "0.1.0");
    const authorization = externalBridgeOwnerReady();
    Object.defineProperty(authorization, "schemaVersion", {
      enumerable: true,
      get: authorizationGetter,
    });
    const fake = createStorage({ [DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY]: authorization });
    await expect(createDevelopmentAwareLocalAgentBridgeBootstrap({
      nativeBootstrap: vi.fn(async () => undefined),
      storage: fake.storage,
      fetch: vi.fn(),
      now: () => Date.parse("2026-08-20T14:00:00.000Z"),
    })()).rejects.toThrow("Development external bridge owner authorization is invalid.");
    expect(authorizationGetter).not.toHaveBeenCalled();

    const healthGetter = vi.fn(() => true);
    const health = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-health",
      get ok() {
        return healthGetter();
      },
    };
    const valid = createStorage({
      [DEVELOPMENT_EXTERNAL_BRIDGE_OWNER_READY_KEY]: externalBridgeOwnerReady(),
    });
    await expect(createDevelopmentAwareLocalAgentBridgeBootstrap({
      nativeBootstrap: vi.fn(async () => undefined),
      storage: valid.storage,
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => health,
      } as Response)),
      now: () => Date.parse("2026-08-20T14:00:00.000Z"),
    })()).rejects.toThrow("Development external bridge owner health response is invalid.");
    expect(healthGetter).not.toHaveBeenCalled();
  });
});

describe("development runtime control", () => {
  test("keeps the capture commit gate inert when no barrier exists", async () => {
    const fake = createStorage();

    await expect(createDevelopmentCaptureCommitGate({
      storage: fake.storage,
    }).beforeWrite("operation-1")).resolves.toBeUndefined();
    await expect(createDevelopmentCaptureCommitGate({
      storage: fake.storage,
    }).afterWrite("operation-1")).resolves.toBeUndefined();
  });

  test("fails closed when a present capture barrier is not exact", async () => {
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce: "too-short",
        phase: "pre_write",
        state: "armed",
      },
    });

    await expect(createDevelopmentCaptureCommitGate({
      storage: fake.storage,
    }).beforeWrite("operation-1")).rejects.toThrow(
      "Development capture commit barrier schema is invalid.",
    );
    expect(fake.values.get(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY)).toEqual({
      version: 1,
      nonce: "too-short",
      phase: "pre_write",
      state: "armed",
    });
  });

  test.each([
    ["missing phase", {
      version: 1,
      nonce: "capture_barrier_nonce_1234",
      state: "armed",
    }],
    ["extra key", {
      version: 1,
      nonce: "capture_barrier_nonce_1234",
      phase: "pre_write",
      state: "armed",
      extra: true,
    }],
    ["invalid phase", {
      version: 1,
      nonce: "capture_barrier_nonce_1234",
      phase: "after_storage",
      state: "armed",
    }],
    ["armed operation id", {
      version: 1,
      nonce: "capture_barrier_nonce_1234",
      operationId: "operation-1",
      phase: "pre_write",
      state: "armed",
    }],
    ["entered without operation id", {
      version: 1,
      nonce: "capture_barrier_nonce_1234",
      phase: "pre_write",
      state: "entered",
    }],
    ["untrimmed operation id", {
      version: 1,
      nonce: "capture_barrier_nonce_1234",
      operationId: " operation-1",
      phase: "pre_write",
      state: "entered",
    }],
  ])("rejects a %s barrier schema", async (_label, value) => {
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: value,
    });

    await expect(createDevelopmentCaptureCommitGate({
      storage: fake.storage,
    }).beforeWrite("operation-1")).rejects.toThrow(
      "Development capture commit barrier schema is invalid.",
    );
  });

  test("blocks one exact pre-write operation until the matching barrier is released", async () => {
    const nonce = "capture_barrier_nonce_1234";
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce,
        phase: "pre_write",
        state: "armed",
      },
    });
    let releaseDelay: (() => void) | undefined;
    const gate = createDevelopmentCaptureCommitGate({
      storage: fake.storage,
      delay: () => new Promise<void>((resolve) => {
        releaseDelay = resolve;
      }),
    });

    const waiting = gate.beforeWrite("operation-1");
    const entered = await waitForBarrierState(fake.values, "entered");
    while (!releaseDelay) await Promise.resolve();
    expect(entered).toEqual({
      version: 1,
      nonce,
      operationId: "operation-1",
      phase: "pre_write",
      state: "entered",
    });
    fake.values.set(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY, {
      ...entered,
      state: "released",
    });
    releaseDelay?.();

    await expect(waiting).resolves.toBeUndefined();
    expect(fake.values.has(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY)).toBe(false);
  });

  test("blocks one exact post-write operation only after the durable write hook", async () => {
    const nonce = "post_write_barrier_nonce_1234";
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce,
        phase: "post_write",
        state: "armed",
      },
    });
    let releaseDelay: (() => void) | undefined;
    const gate = createDevelopmentCaptureCommitGate({
      storage: fake.storage,
      delay: () => new Promise<void>((resolve) => {
        releaseDelay = resolve;
      }),
    });

    await expect(gate.beforeWrite("operation-2")).resolves.toBeUndefined();
    expect(fake.values.get(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY)).toMatchObject({
      phase: "post_write",
      state: "armed",
    });
    const waiting = gate.afterWrite("operation-2");
    const entered = await waitForBarrierState(fake.values, "entered");
    while (!releaseDelay) await Promise.resolve();
    expect(entered).toEqual({
      version: 1,
      nonce,
      operationId: "operation-2",
      phase: "post_write",
      state: "entered",
    });
    fake.values.set(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY, {
      ...entered,
      state: "released",
    });
    releaseDelay?.();

    await expect(waiting).resolves.toBeUndefined();
    expect(fake.values.has(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY)).toBe(false);
  });

  test("fails closed when a pre-write barrier reaches only the post-write hook", async () => {
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce: "stale_pre_write_nonce_1234",
        phase: "pre_write",
        state: "armed",
      },
    });

    await expect(createDevelopmentCaptureCommitGate({
      storage: fake.storage,
    }).afterWrite("operation-3")).rejects.toThrow(
      "Development capture commit barrier phase is stale.",
    );
  });

  test("fails closed when an entered barrier is reused as a new hook input", async () => {
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce: "entered_barrier_nonce_1234",
        operationId: "operation-old",
        phase: "pre_write",
        state: "entered",
      },
    });

    await expect(createDevelopmentCaptureCommitGate({
      storage: fake.storage,
    }).beforeWrite("operation-new")).rejects.toThrow(
      "Development capture commit barrier is not armed.",
    );
  });

  test("fails closed when barrier authority changes while a write is waiting", async () => {
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce: "capture_barrier_nonce_1234",
        phase: "pre_write",
        state: "armed",
      },
    });
    let releaseDelay: (() => void) | undefined;
    const gate = createDevelopmentCaptureCommitGate({
      storage: fake.storage,
      delay: () => new Promise<void>((resolve) => {
        releaseDelay = resolve;
      }),
    });

    const waiting = gate.beforeWrite("operation-1");
    await waitForBarrierState(fake.values, "entered");
    while (!releaseDelay) await Promise.resolve();
    fake.values.set(DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY, {
      version: 1,
      nonce: "different_barrier_nonce_5678",
      operationId: "operation-1",
      phase: "pre_write",
      state: "released",
    });
    releaseDelay?.();

    await expect(waiting).rejects.toThrow(
      "Development capture commit barrier authority changed.",
    );
  });

  test("fails closed when a development barrier is not released before its deadline", async () => {
    const fake = createStorage({
      [DEVELOPMENT_CAPTURE_COMMIT_BARRIER_KEY]: {
        version: 1,
        nonce: "capture_barrier_nonce_1234",
        phase: "pre_write",
        state: "armed",
      },
    });
    let now = 0;
    const gate = createDevelopmentCaptureCommitGate({
      storage: fake.storage,
      delay: async () => {
        now += 1;
      },
      now: () => now,
      timeoutMs: 0,
    });

    await expect(gate.beforeWrite("operation-1")).rejects.toThrow(
      "Development capture commit barrier timed out.",
    );
  });

  test.each([
    ["after-approved-before-mutation", "afterApproved"],
    ["after-canonical-before-commit-marker", "afterCanonicalCommit"],
    ["after-committed-before-reconcile-ack", "afterCommitted"],
  ] as const)("blocks and releases the exact lifecycle %s checkpoint", async (phase, method) => {
    const nonce = `lifecycle_${method}_nonce_1234`;
    const operationId = "11111111-1111-4111-8111-111111111111";
    const fake = createStorage({
      [DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY]: {
        version: 1,
        nonce,
        phase,
        state: "armed",
      },
    });
    let releaseDelay: (() => void) | undefined;
    const gate = createDevelopmentAnnotationLifecycleExecutionGate({
      storage: fake.storage,
      delay: () => new Promise<void>((resolve) => {
        releaseDelay = resolve;
      }),
    });
    if (method !== "afterApproved") await expect(gate.afterApproved(operationId)).resolves.toBeUndefined();
    if (method === "afterCommitted") {
      await expect(gate.afterCanonicalCommit(operationId)).resolves.toBeUndefined();
    }

    const waiting = gate[method](operationId);
    const entered = await waitForBarrierState(
      fake.values,
      "entered",
      DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY,
    );
    while (!releaseDelay) await Promise.resolve();
    expect(entered).toEqual({ version: 1, nonce, phase, state: "entered", operationId });
    fake.values.set(DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY, {
      ...entered,
      state: "released",
    });
    releaseDelay?.();

    await expect(waiting).resolves.toBeUndefined();
    expect(fake.values.has(DEVELOPMENT_ANNOTATION_LIFECYCLE_EXECUTION_BARRIER_KEY)).toBe(false);
  });

  test("accepts only an exact authenticated loopback ping", () => {
    const fake = createRuntime();
    createDevelopmentRuntimeControl({
      buildId: "build-2",
      expectedSenderUrl: "http://127.0.0.1:41731/reload",
      runtime: fake.runtime,
      token: "test-token",
    }).register();

    expect(fake.dispatch(ping()).responses).toEqual([{
      buildId: "build-2",
      ok: true,
    }]);
    expect(fake.dispatch(ping("build-3", "wrong-token")).responses).toEqual([]);
    expect(fake.dispatch(ping(), "http://localhost:41731/reload").responses).toEqual([]);
    expect(fake.dispatch({ ...ping(), extra: true }).responses).toEqual([]);
    expect(fake.dispatch({
      action: "ping",
      token: "test-token",
      type: "meanthis:development-runtime-control:v1",
    }).responses).toEqual([]);
  });

  test("acknowledges reload before invoking the runtime reload sink", async () => {
    const fake = createRuntime();
    const queued: Array<() => void> = [];
    createDevelopmentRuntimeControl({
      buildId: "build-2",
      expectedSenderUrl: "http://127.0.0.1:41731/reload",
      queueTask: (task) => queued.push(task),
      runtime: fake.runtime,
      token: "test-token",
    }).register();

    const result = fake.dispatch(reload());
    expect(result.responses).toEqual([{ buildId: "build-2", ok: true }]);
    expect(fake.reload).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);

    queued[0]?.();
    expect(fake.reload).toHaveBeenCalledTimes(1);
  });

  test("rejects stale, no-op, and non-exact reload identities before the sink", () => {
    const fake = createRuntime();
    const queued: Array<() => void> = [];
    createDevelopmentRuntimeControl({
      buildId: "build-2",
      expectedSenderUrl: "http://127.0.0.1:41731/reload",
      queueTask: (task) => queued.push(task),
      runtime: fake.runtime,
      token: "test-token",
    }).register();

    expect(fake.dispatch(reload("build-1", "build-3")).responses).toEqual([]);
    expect(fake.dispatch(reload("build-2", "build-2")).responses).toEqual([]);
    expect(fake.dispatch({ ...reload(), extra: true }).responses).toEqual([]);
    expect(queued).toEqual([]);
    expect(fake.reload).not.toHaveBeenCalled();
  });

  test("keeps the control surface inert without a build token", () => {
    const fake = createRuntime();
    createDevelopmentRuntimeControl({
      buildId: "build-2",
      expectedSenderUrl: "http://127.0.0.1:41731/reload",
      runtime: fake.runtime,
      token: "",
    }).register();

    expect(fake.dispatch(ping()).responses).toEqual([]);
  });

  test("returns a bounded local-only snapshot of background runtime failures", () => {
    const fake = createRuntime();
    const events = createEventTarget();
    createDevelopmentRuntimeControl({
      buildId: "build-2",
      eventTarget: events.eventTarget,
      expectedSenderUrl: "http://127.0.0.1:41731/reload",
      now: () => "2026-08-20T14:00:00.000Z",
      runtime: fake.runtime,
      token: "test-token",
    }).register();

    events.dispatch("error", { message: "background exploded test-token" });
    events.dispatch("unhandledrejection", { reason: new Error("promise failed") });

    expect(fake.dispatch({
      action: "diagnostics",
      observedBuildId: "build-2",
      targetBuildId: "build-2",
      token: "test-token",
      type: "meanthis:development-runtime-control:v1",
    }).responses).toEqual([{
      buildId: "build-2",
      events: [
        {
          at: "2026-08-20T14:00:00.000Z",
          kind: "error",
          message: "background exploded [redacted]",
        },
        {
          at: "2026-08-20T14:00:00.000Z",
          kind: "unhandledrejection",
          message: "promise failed",
        },
      ],
      ok: true,
    }]);
    expect(fake.dispatch({
      action: "diagnostics",
      observedBuildId: "build-1",
      targetBuildId: "build-2",
      token: "test-token",
      type: "meanthis:development-runtime-control:v1",
    }).responses).toEqual([]);
  });
});
