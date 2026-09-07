import { describe, expect, test } from "vitest";
import type { ExtensionStorageArea } from "./capture-store";
import { UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST } from "./messages";
import {
  CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
  createClearProjectionStore,
  parseClearProjectionJournal,
  withClearProjectionOperationLease,
  type ClearProjectionAuthorityReference,
  type ClearProjectionSubject,
} from "./clear-projection-store";

const AUTHORITY: ClearProjectionAuthorityReference = {
  authorityId: "authority-1",
  operationId: "clear-page-1",
  generation: 1,
};
const ORIGIN = "https://app.example.test";
const SUBJECT: ClearProjectionSubject = {
  tabId: 7,
  frameId: 0,
  documentId: "document-1",
  origin: ORIGIN,
  pathname: "/settings",
};

describe("EA-01B-CLEAR-C3 durable clear projection journal", () => {
  test("C4 generation2 persists an immutable pre-C1 request identity and exact epochs", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    const input = {
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN, "https://other.example.test"],
      request: {
        nonce: "request-nonce-1",
        endpoint: { ...SUBJECT },
        origins: [
          { origin: ORIGIN, beforeEpoch: "epoch-1" },
          { origin: "https://other.example.test", beforeEpoch: null },
        ],
      },
      targets: [targetInput()],
    };

    const prepared = await store.prepare(input);
    expect(prepared).toMatchObject({ ok: true, value: { request: input.request } });
    input.request.endpoint.documentId = "mutated-document";
    input.request.origins[0]!.beforeEpoch = "mutated-epoch";
    if (!prepared.ok) throw new Error(prepared.message);
    prepared.value.request!.endpoint.documentId = "mutated-readback";

    await expect(store.listOperations()).resolves.toMatchObject({
      ok: true,
      value: [{
        request: {
          nonce: "request-nonce-1",
          endpoint: SUBJECT,
          origins: [
            { origin: ORIGIN, beforeEpoch: "epoch-1" },
            { origin: "https://other.example.test", beforeEpoch: null },
          ],
        },
      }],
    });
  });

  test("C4 generation2 parses legacy journals but requires request identity for new prepare", async () => {
    const legacy = {
      version: 1,
      operations: [{
        version: 1,
        operationId: AUTHORITY.operationId,
        authority: null,
        requestedOrigins: [ORIGIN],
        origins: [],
        subjectDiscovery: "complete",
        targets: [],
      }],
    };
    expect(parseClearProjectionJournal(legacy)).toMatchObject({
      operations: [{ operationId: AUTHORITY.operationId, request: null }],
    });
    await expect(createClearProjectionStore({ storage: new RecordingStorage() }).prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  test("persists active-origin barrier authority and rejects a same-ID live-page replay", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    const activeOriginRequest = {
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: {
        ...requestIdentity([ORIGIN]),
        barrierScope: "active-origin" as const,
      },
      targets: [targetInput()],
    };

    await expect(store.prepare(activeOriginRequest)).resolves.toMatchObject({
      ok: true,
      value: { request: { barrierScope: "active-origin" } },
    });
    await expect(store.prepare({
      ...activeOriginRequest,
      request: {
        ...activeOriginRequest.request,
        barrierScope: "live-page",
      },
    })).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
    expect(parseClearProjectionJournal(storage.peek(
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
    ))).toMatchObject({
      operations: [{ request: { barrierScope: "active-origin" } }],
    });
  });

  test.each([undefined, null, "page", "ACTIVE-ORIGIN"])(
    "rejects malformed stored barrier scope %s",
    (barrierScope) => {
      expect(parseClearProjectionJournal({
        version: 1,
        operations: [{
          version: 1,
          operationId: AUTHORITY.operationId,
          authority: null,
          request: {
            ...requestIdentity([ORIGIN]),
            barrierScope,
          },
          requestedOrigins: [ORIGIN],
          origins: [],
          subjectDiscovery: "pending",
          targets: [],
        }],
      })).toBeNull();
    },
  );

  test.each([
    ["missing", { nonce: "request-1", origins: [{ origin: ORIGIN, beforeEpoch: null }] }],
    ["duplicate origin", {
      nonce: "request-1",
      endpoint: SUBJECT,
      origins: [
        { origin: ORIGIN, beforeEpoch: null },
        { origin: ORIGIN, beforeEpoch: null },
      ],
    }],
    ["overbound epoch", {
      nonce: "request-1",
      endpoint: SUBJECT,
      origins: [{ origin: ORIGIN, beforeEpoch: "e".repeat(129) }],
    }],
    ["inherited nonce", Object.assign(Object.create({ nonce: "request-1" }), {
      endpoint: SUBJECT,
      origins: [{ origin: ORIGIN, beforeEpoch: null }],
    })],
  ])("C4 generation2 rejects %s durable request identity", (_name, request) => {
    expect(parseClearProjectionJournal({
      version: 1,
      operations: [{
        version: 1,
        operationId: AUTHORITY.operationId,
        authority: null,
        request,
        requestedOrigins: [ORIGIN],
        origins: [],
        subjectDiscovery: "pending",
        targets: [],
      }],
    })).toBeNull();
  });

  test("C4 generation2 refuses to remove bound nonterminal work", async () => {
    const store = createClearProjectionStore({ storage: new RecordingStorage() });
    await prepareTarget(store);
    await expect(store.removeOperation(AUTHORITY)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
    });
    await expect(store.listPending(Number.MAX_SAFE_INTEGER)).resolves.toMatchObject({
      ok: true,
      value: [{ authority: AUTHORITY, state: "pending" }],
    });
  });

  test("C4 generation2 serializes replacement behind an operation-scoped external await", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    const replacementStore = createClearProjectionStore({ storage });
    await prepareTarget(store);
    const leaseStarted = deferred<void>();
    const releaseLease = deferred<void>();
    const held = withClearProjectionOperationLease(AUTHORITY.operationId, async () => {
      leaseStarted.resolve(undefined);
      await releaseLease.promise;
    });
    await leaseStarted.promise;
    let replacementSettled = false;
    const replacement = replacementStore.replaceTarget(AUTHORITY, {
      previous: {
        subject: SUBJECT,
        projectionId: "projection-1",
        revision: 3,
      },
      target: {
        ...targetInput(1),
        subject: { ...SUBJECT, documentId: "replacement-document", pathname: "/replacement" },
        revision: 4,
      },
    }).then((result) => {
      replacementSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);
    releaseLease.resolve(undefined);
    await held;
    await expect(replacement).resolves.toMatchObject({
      ok: true,
      value: { subject: { documentId: "replacement-document" }, revision: 4 },
    });
  });

  test("C4 generation5 never deletes a newer unbound operation that replaces the stable snapshot before the remove RMW", async () => {
    const storage = new RecordingStorage();
    const snapshotStore = createClearProjectionStore({ storage });
    const retiringStore = createClearProjectionStore({ storage });
    const prepared = await snapshotStore.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
      targets: [targetInput()],
    });
    if (!prepared.ok) throw new Error(prepared.message);
    const expected = prepared.value;
    const newer = structuredClone(expected);
    newer.request!.nonce = "request-newer-context";
    newer.request!.endpoint.documentId = "replacement-document";
    newer.targets[0]!.subject.documentId = "replacement-document";

    const releaseRemoveRead = storage.pauseNextGet();
    const removal = retiringStore.removeExactUnboundOperation(expected, () => true);
    await storage.waitForPausedGet();
    storage.seed({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: { version: 1, operations: [newer] },
    });
    releaseRemoveRead();

    await expect(removal).resolves.toMatchObject({ ok: false, code: "STALE_REFERENCE" });
    expect(storage.peek(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toEqual({
      version: 1,
      operations: [newer],
    });
  });

  test("C4 generation5 evaluates the retirement guard inside the acquired Web Lock", async () => {
    const storage = new RecordingStorage();
    const lockStarted = deferred<void>();
    const releaseLock = deferred<void>();
    let pauseLock = false;
    let generation = 0;
    const store = createClearProjectionStore({
      storage,
      withLock: async (operation) => {
        if (pauseLock) {
          lockStarted.resolve(undefined);
          await releaseLock.promise;
        }
        return operation();
      },
    });
    const prepared = await store.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
      targets: [targetInput()],
    });
    if (!prepared.ok) throw new Error(prepared.message);
    pauseLock = true;

    const removal = store.removeExactUnboundOperation(
      prepared.value,
      () => generation === 0,
    );
    await lockStarted.promise;
    generation += 1;
    releaseLock.resolve(undefined);

    await expect(removal).resolves.toMatchObject({ ok: false, code: "STALE_REFERENCE" });
    await expect(store.listOperations()).resolves.toEqual({
      ok: true,
      value: [prepared.value],
    });
  });

  test("persists an undeliverable target snapshot before C1 and filters it at authority bind", async () => {
    const storage = new RecordingStorage();
    const firstStore = createClearProjectionStore({ storage });
    const otherOrigin = "https://other.example.test";
    const otherTarget = {
      ...targetInput(1),
      subject: { ...targetInput(1).subject, origin: otherOrigin },
    };
    await expect(firstStore.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN, otherOrigin],
      request: requestIdentity([ORIGIN, otherOrigin]),
      targets: [targetInput(), otherTarget],
    })).resolves.toMatchObject({
      ok: true,
      value: {
        authority: null,
        subjectDiscovery: "complete",
        targets: [{ subject: SUBJECT }, { subject: { origin: otherOrigin } }],
      },
    });
    await expect(firstStore.listPending(Number.MAX_SAFE_INTEGER)).resolves.toEqual({
      ok: true,
      value: [],
    });

    const restartedStore = createClearProjectionStore({ storage });
    await expect(restartedStore.commitOrigins(AUTHORITY, [{
      origin: ORIGIN,
      originAfterEpoch: "epoch-app",
    }])).resolves.toMatchObject({
      ok: true,
      value: {
        authority: AUTHORITY,
        targets: [{ subject: SUBJECT }],
      },
    });
    await expect(restartedStore.listPending(100)).resolves.toMatchObject({
      ok: true,
      value: [{ subject: SUBJECT, originAfterEpoch: "epoch-app" }],
    });
  });

  test("persists an unbound provisional before C1 and binds its authority afterwards", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    const request = {
      operationId: AUTHORITY.operationId,
      requestedOrigins: ["https://z.example.test", ORIGIN],
      request: requestIdentity(["https://z.example.test", ORIGIN]),
    };

    const first = await store.prepare(request);
    const repeated = await store.prepare({ ...request, requestedOrigins: [...request.requestedOrigins] });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      ok: true,
      value: {
        operationId: AUTHORITY.operationId,
        authority: null,
        request: request.request,
        requestedOrigins: [ORIGIN, "https://z.example.test"],
        origins: [],
        subjectDiscovery: "pending",
        targets: [],
      },
    });
    expect(storage.setCalls).toHaveLength(1);
    expect(storage.peek(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toEqual({
      version: 1,
      operations: [{
        version: 1,
        operationId: AUTHORITY.operationId,
        authority: null,
        request: request.request,
        requestedOrigins: [ORIGIN, "https://z.example.test"],
        origins: [],
        subjectDiscovery: "pending",
        targets: [],
      }],
    });

    await expect(store.commitOrigins(AUTHORITY, [
      { origin: "https://outside.example.test", originAfterEpoch: "epoch-outside" },
    ])).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
    await expect(store.listOperations()).resolves.toMatchObject({
      ok: true,
      value: [{ authority: null, origins: [] }],
    });
    await expect(store.commitOrigins(AUTHORITY, [
      { origin: ORIGIN, originAfterEpoch: "epoch-app" },
    ])).resolves.toMatchObject({
      ok: true,
      value: { authority: AUTHORITY },
    });
    await expect(store.prepare({
      operationId: "   ",
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    })).resolves
      .toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    await expect(store.commitOrigins({ ...AUTHORITY, generation: 0 }, [
      { origin: ORIGIN, originAfterEpoch: "epoch-app" },
    ])).resolves
      .toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  test("commits sorted origins incrementally and recovers them after restart", async () => {
    const storage = new RecordingStorage();
    const firstStore = createClearProjectionStore({ storage });
    await firstStore.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN, "https://z.example.test"],
      request: requestIdentity([ORIGIN, "https://z.example.test"]),
    });

    await expect(firstStore.commitOrigins(AUTHORITY, [
      { origin: "https://z.example.test", originAfterEpoch: "epoch-z" },
      { origin: ORIGIN, originAfterEpoch: "epoch-app" },
    ])).resolves.toMatchObject({
      ok: true,
      value: {
        origins: [
          { origin: ORIGIN, originAfterEpoch: "epoch-app" },
          { origin: "https://z.example.test", originAfterEpoch: "epoch-z" },
        ],
      },
    });
    const writesAfterCommit = storage.setCalls.length;
    await expect(firstStore.commitOrigins(AUTHORITY, [
      { origin: ORIGIN, originAfterEpoch: "epoch-app" },
    ])).resolves.toMatchObject({ ok: true });
    expect(storage.setCalls).toHaveLength(writesAfterCommit);

    const restartedStore = createClearProjectionStore({ storage });
    await expect(restartedStore.listOperations()).resolves.toMatchObject({
      ok: true,
      value: [{
        authority: AUTHORITY,
        origins: [
          { origin: ORIGIN, originAfterEpoch: "epoch-app" },
          { origin: "https://z.example.test", originAfterEpoch: "epoch-z" },
        ],
      }],
    });
  });

  test("does not expose an unbound provisional to target delivery and discards it by operation id", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await store.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    });

    await expect(store.upsertTarget(AUTHORITY, targetInput())).resolves.toMatchObject({
      ok: false,
      code: "OPERATION_NOT_BOUND",
    });
    await expect(store.markDelivered(AUTHORITY, {
      subject: SUBJECT,
      projectionId: "projection-1",
      revision: 3,
      expectedAttemptCount: 0,
      nextAttemptAt: 200,
    })).resolves.toMatchObject({ ok: false, code: "OPERATION_NOT_BOUND" });
    await expect(store.acknowledge(AUTHORITY, {
      subject: SUBJECT,
      projectionId: "projection-1",
      revision: 3,
      readback: {
        appliedItemIds: [],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
      },
    })).resolves.toMatchObject({ ok: false, code: "OPERATION_NOT_BOUND" });
    await expect(store.listPending(Number.MAX_SAFE_INTEGER)).resolves.toEqual({
      ok: true,
      value: [],
    });

    await expect(store.removeOperation(AUTHORITY.operationId)).resolves.toMatchObject({
      ok: true,
      value: { operationId: AUTHORITY.operationId, authority: null },
    });
    await expect(store.removeOperation(AUTHORITY.operationId)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(storage.peek(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toBeUndefined();
  });

  test("stores deterministic exact-subject cleanup work and exposes only due work", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await prepareCommitted(store);

    await expect(store.upsertTarget(AUTHORITY, {
      subject: SUBJECT,
      removedItemIds: ["removed-z", "removed-a", "removed-a"],
      projectionId: "projection-1",
      revision: 3,
      nextAttemptAt: 100,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        removedItemIds: ["removed-a", "removed-z"],
        state: "pending",
        attemptCount: 0,
      },
    });
    await expect(store.upsertTarget(AUTHORITY, {
      subject: SUBJECT,
      removedItemIds: ["removed-a", "removed-z"],
      projectionId: "projection-1",
      revision: 3,
      nextAttemptAt: 100,
    })).resolves.toMatchObject({ ok: true });
    await expect(store.completeSubjectDiscovery(AUTHORITY)).resolves.toMatchObject({
      ok: true,
      value: { subjectDiscovery: "complete" },
    });

    await expect(store.listPending(99)).resolves.toEqual({ ok: true, value: [] });
    await expect(store.listPending(100)).resolves.toMatchObject({
      ok: true,
      value: [{
        authority: AUTHORITY,
        originAfterEpoch: "epoch-app",
        subject: SUBJECT,
        removedItemIds: ["removed-a", "removed-z"],
        state: "pending",
      }],
    });
  });

  test("linearizes concurrent store instances and invokes the supplied Web Lock wrapper", async () => {
    const storage = new RecordingStorage();
    const lockCalls: string[] = [];
    const firstStore = createClearProjectionStore({
      storage,
      withLock: async (operation) => {
        lockCalls.push("first");
        return operation();
      },
    });
    const secondStore = createClearProjectionStore({
      storage,
      withLock: async (operation) => {
        lockCalls.push("second");
        return operation();
      },
    });
    const releaseFirstRead = storage.pauseNextGet();
    const first = firstStore.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    });
    await storage.waitForPausedGet();
    const secondAuthority = {
      authorityId: "authority-1",
      operationId: "clear-page-2",
      generation: 2,
    };
    const second = secondStore.prepare({
      operationId: secondAuthority.operationId,
      requestedOrigins: ["https://second.example.test"],
      request: requestIdentity(
        ["https://second.example.test"],
        secondAuthority.operationId,
        "https://second.example.test",
      ),
    });
    releaseFirstRead();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: true },
      { ok: true },
    ]);
    await expect(firstStore.listOperations()).resolves.toMatchObject({
      ok: true,
      value: [
        { operationId: AUTHORITY.operationId, authority: null },
        { operationId: secondAuthority.operationId, authority: null },
      ],
    });
    expect(lockCalls).toEqual(["first", "second"]);
  });

  test("linearizes authority binding before a concurrently queued target upsert", async () => {
    const storage = new RecordingStorage();
    const bindingStore = createClearProjectionStore({ storage });
    const targetStore = createClearProjectionStore({ storage });
    await bindingStore.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    });

    const [committed, inserted] = await Promise.all([
      bindingStore.commitOrigins(AUTHORITY, [
        { origin: ORIGIN, originAfterEpoch: "epoch-app" },
      ]),
      targetStore.upsertTarget(AUTHORITY, targetInput()),
    ]);

    expect(committed).toMatchObject({ ok: true, value: { authority: AUTHORITY } });
    expect(inserted).toMatchObject({ ok: true, value: { state: "pending" } });
    await expect(targetStore.listPending(100)).resolves.toMatchObject({
      ok: true,
      value: [{ authority: AUTHORITY, originAfterEpoch: "epoch-app" }],
    });
  });

  test("makes delivery attempts retryable without double-counting duplicate mutations", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await prepareTarget(store);
    const delivery = {
      subject: SUBJECT,
      projectionId: "projection-1",
      revision: 3,
      expectedAttemptCount: 0,
      nextAttemptAt: 200,
    };

    const first = await store.markDelivered(AUTHORITY, delivery);
    const repeated = await store.markDelivered(AUTHORITY, delivery);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      value: { state: "delivered", attemptCount: 1, nextAttemptAt: 200 },
    });
    await expect(store.listPending(199)).resolves.toEqual({ ok: true, value: [] });
    await expect(store.listPending(200)).resolves.toMatchObject({
      ok: true,
      value: [{ state: "delivered", attemptCount: 1 }],
    });
    await expect(store.markDelivered(AUTHORITY, {
      ...delivery,
      expectedAttemptCount: 1,
      nextAttemptAt: 300,
    })).resolves.toMatchObject({
      ok: true,
      value: { state: "delivered", attemptCount: 2, nextAttemptAt: 300 },
    });
  });

  test("acknowledges only an exact delivered revision with strict zero-marker readback", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await prepareTarget(store);
    await store.markDelivered(AUTHORITY, {
      subject: SUBJECT,
      projectionId: "projection-1",
      revision: 3,
      expectedAttemptCount: 0,
      nextAttemptAt: 200,
    });
    const acknowledgement = {
      subject: SUBJECT,
      projectionId: "projection-1",
      revision: 3,
      readback: {
        appliedItemIds: [],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
      },
    } as const;

    await expect(store.acknowledge(AUTHORITY, {
      ...acknowledgement,
      readback: { ...acknowledgement.readback, markerCount: 1 },
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(store.acknowledge(AUTHORITY, {
      ...acknowledgement,
      readback: { ...acknowledgement.readback, digest: "0".repeat(64) },
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(store.acknowledge(AUTHORITY, {
      ...acknowledgement,
      revision: 4,
    })).resolves.toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });

    const first = await store.acknowledge(AUTHORITY, acknowledgement);
    const repeated = await store.acknowledge(AUTHORITY, acknowledgement);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { state: "acknowledged" } });
    await expect(store.listPending(Number.MAX_SAFE_INTEGER)).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  test("supersedes exact targets idempotently and never delivers a terminal target", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await prepareTarget(store);
    const targetRef = { subject: SUBJECT, projectionId: "projection-1", revision: 3 };

    const first = await store.supersede(AUTHORITY, targetRef);
    const repeated = await store.supersede(AUTHORITY, targetRef);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { state: "superseded" } });
    await expect(store.markDelivered(AUTHORITY, {
      ...targetRef,
      expectedAttemptCount: 0,
      nextAttemptAt: 200,
    })).resolves.toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });

  test("atomically writes a replacement document before superseding its old subject", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await prepareTarget(store);
    await store.completeSubjectDiscovery(AUTHORITY);
    const next = {
      ...targetInput(1),
      subject: { ...targetInput(1).subject, frameId: SUBJECT.frameId },
    };

    await expect(store.replaceTarget(AUTHORITY, {
      previous: { subject: SUBJECT, projectionId: "projection-1", revision: 3 },
      target: next,
    })).resolves.toMatchObject({ ok: true, value: { subject: next.subject, state: "pending" } });
    await expect(store.listOperations()).resolves.toMatchObject({
      ok: true,
      value: [{
        subjectDiscovery: "complete",
        targets: [expect.objectContaining({ subject: next.subject, state: "pending" })],
      }],
    });
  });

  test("replaces responsibility in place when all 128 target slots are occupied", async () => {
    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await store.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
      targets: Array.from({ length: 128 }, (_, index) => targetInput(index)),
    });
    await store.commitOrigins(AUTHORITY, [{ origin: ORIGIN, originAfterEpoch: "epoch-app" }]);
    const replacement = {
      ...targetInput(),
      subject: { ...SUBJECT, documentId: "replacement-document", pathname: "/replacement" },
      projectionId: "replacement-projection",
      revision: 4,
      nextAttemptAt: 200,
    };

    await expect(store.replaceTarget(AUTHORITY, {
      previous: { subject: SUBJECT, projectionId: "projection-1", revision: 3 },
      target: replacement,
    })).resolves.toMatchObject({
      ok: true,
      value: { subject: replacement.subject, state: "pending" },
    });
    const operations = await store.listOperations();
    expect(operations).toMatchObject({ ok: true, value: [{ targets: expect.any(Array) }] });
    if (!operations.ok) throw new Error("replacement fixture failed");
    expect(operations.value[0]!.targets).toHaveLength(128);
    expect(operations.value[0]!.targets.some((target) =>
      target.subject.frameId === SUBJECT.frameId &&
      target.subject.documentId === SUBJECT.documentId &&
      target.subject.pathname === SUBJECT.pathname
    )).toBe(false);
  });

  test("strictly rejects malformed persisted state without overwriting or pruning it", async () => {
    const storage = new RecordingStorage();
    const malformed = {
      version: 1,
      operations: [{
        version: 1,
        operationId: AUTHORITY.operationId,
        authority: AUTHORITY,
        requestedOrigins: [ORIGIN, "https://z.example.test"],
        origins: [
          { origin: "https://z.example.test", originAfterEpoch: "epoch-z" },
          { origin: ORIGIN, originAfterEpoch: "epoch-app" },
        ],
        subjectDiscovery: "pending",
        targets: [],
        unexpected: true,
      }],
    };
    storage.seed({ [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: malformed });
    const store = createClearProjectionStore({ storage });

    expect(parseClearProjectionJournal(malformed)).toBeNull();
    await expect(store.listOperations()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_STORAGE",
    });
    await expect(store.prepare({
      operationId: "clear-page-2",
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN], "clear-page-2"),
    })).resolves.toMatchObject({ ok: false, code: "INVALID_STORAGE" });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
    expect(storage.peek(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toEqual(malformed);
  });

  test("enforces every collection and identifier bound without silent truncation", async () => {
    const operationStorage = new RecordingStorage();
    const operationStore = createClearProjectionStore({ storage: operationStorage });
    for (let generation = 1; generation <= 16; generation += 1) {
      const origin = `https://origin-${generation}.example.test`;
      await expect(operationStore.prepare({
        operationId: `clear-${generation.toString().padStart(2, "0")}`,
        requestedOrigins: [origin],
        request: requestIdentity(
          [origin],
          `clear-${generation.toString().padStart(2, "0")}`,
          origin,
        ),
      })).resolves.toMatchObject({ ok: true });
    }
    const seventeenthOrigin = "https://origin-17.example.test";
    await expect(operationStore.prepare({
      operationId: "clear-17",
      requestedOrigins: [seventeenthOrigin],
      request: requestIdentity([seventeenthOrigin], "clear-17", seventeenthOrigin),
    })).resolves.toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    await expect(operationStore.listOperations()).resolves.toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ operationId: "clear-01", authority: null }),
        expect.objectContaining({ operationId: "clear-16", authority: null }),
      ]),
    });

    const storage = new RecordingStorage();
    const store = createClearProjectionStore({ storage });
    await store.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    });
    await expect(createClearProjectionStore({ storage: new RecordingStorage() }).prepare({
      operationId: "clear-too-many-origins",
      requestedOrigins: Array.from(
        { length: 65 },
        (_, index) => `https://origin-${index}.example.test`,
      ),
      request: requestIdentity([ORIGIN], "clear-too-many-origins"),
    })).resolves.toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    await expect(store.prepare({
      operationId: "o".repeat(129),
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(store.commitOrigins(AUTHORITY, Array.from({ length: 65 }, (_, index) => ({
      origin: `https://origin-${index}.example.test`,
      originAfterEpoch: `epoch-${index}`,
    })))).resolves.toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    await store.commitOrigins(AUTHORITY, [{ origin: ORIGIN, originAfterEpoch: "epoch-app" }]);
    await expect(store.upsertTarget(AUTHORITY, {
      ...targetInput(),
      removedItemIds: Array.from({ length: 27 }, (_, index) => `item-${index}`),
    })).resolves.toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    await expect(store.upsertTarget(AUTHORITY, {
      ...targetInput(),
      removedItemIds: ["i".repeat(129)],
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(store.upsertTarget(AUTHORITY, {
      ...targetInput(),
      projectionId: "p".repeat(65),
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(store.upsertTarget(AUTHORITY, {
      ...targetInput(),
      subject: { ...SUBJECT, documentId: "d".repeat(257) },
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });

    for (let index = 0; index < 128; index += 1) {
      await expect(store.upsertTarget(AUTHORITY, targetInput(index))).resolves.toMatchObject({
        ok: true,
      });
    }
    await expect(store.upsertTarget(AUTHORITY, targetInput(128))).resolves.toMatchObject({
      ok: false,
      code: "LIMIT_EXCEEDED",
    });
    const operations = await store.listOperations();
    expect(operations).toMatchObject({ ok: true, value: [{ targets: { length: 128 } }] });
  });

  test("fails closed on read, write, and remove storage failures", async () => {
    const readStorage = new RecordingStorage();
    readStorage.failNextGet("read unavailable");
    await expect(createClearProjectionStore({ storage: readStorage }).prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    })).resolves
      .toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(readStorage.setCalls).toEqual([]);

    const writeStorage = new RecordingStorage();
    writeStorage.failNextSet("write unavailable");
    await expect(createClearProjectionStore({ storage: writeStorage }).prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    })).resolves
      .toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(writeStorage.peek(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toBeUndefined();

    const removeStorage = new RecordingStorage();
    const removeStore = createClearProjectionStore({ storage: removeStorage });
    await removeStore.prepare({
      operationId: AUTHORITY.operationId,
      requestedOrigins: [ORIGIN],
      request: requestIdentity([ORIGIN]),
    });
    removeStorage.failNextRemove("remove unavailable");
    await expect(removeStore.removeOperation(AUTHORITY.operationId)).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(removeStorage.peek(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toBeDefined();
  });
});

type Store = ReturnType<typeof createClearProjectionStore>;

async function prepareCommitted(store: Store): Promise<void> {
  await store.prepare({
    operationId: AUTHORITY.operationId,
    requestedOrigins: [ORIGIN],
    request: requestIdentity([ORIGIN]),
  });
  await store.commitOrigins(AUTHORITY, [{ origin: ORIGIN, originAfterEpoch: "epoch-app" }]);
}

function requestIdentity(
  requestedOrigins: readonly string[],
  operationId = AUTHORITY.operationId,
  endpointOrigin = ORIGIN,
) {
  return {
    nonce: `request-${operationId}`.slice(0, 128),
    endpoint: { ...SUBJECT, origin: endpointOrigin },
    origins: [...requestedOrigins].sort().map((origin) => ({
      origin,
      beforeEpoch: origin === ORIGIN ? "epoch-before" : null,
    })),
  };
}

async function prepareTarget(store: Store): Promise<void> {
  await prepareCommitted(store);
  await store.upsertTarget(AUTHORITY, targetInput());
}

function targetInput(index = 0) {
  return {
    subject: index === 0 ? SUBJECT : {
      ...SUBJECT,
      frameId: index,
      documentId: `document-${index}`,
      pathname: `/settings/${index}`,
    },
    removedItemIds: ["removed-z", "removed-a"],
    projectionId: `projection-${index + 1}`,
    revision: 3,
    nextAttemptAt: 100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class RecordingStorage implements ExtensionStorageArea {
  private readonly values = new Map<string, unknown>();
  private getFailure: string | null = null;
  private setFailure: string | null = null;
  private removeFailure: string | null = null;
  private getPause: { started: () => void; release: Promise<void> } | null = null;
  private pausedGetStarted: Promise<void> = Promise.resolve();
  readonly setCalls: Array<Record<string, unknown>> = [];
  readonly removeCalls: string[][] = [];

  seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  peek(key: string): unknown {
    return structuredClone(this.values.get(key));
  }

  failNextGet(message: string): void {
    this.getFailure = message;
  }

  failNextSet(message: string): void {
    this.setFailure = message;
  }

  failNextRemove(message: string): void {
    this.removeFailure = message;
  }

  pauseNextGet(): () => void {
    let started!: () => void;
    let release!: () => void;
    this.pausedGetStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.getPause = { started, release: released };
    return release;
  }

  waitForPausedGet(): Promise<void> {
    return this.pausedGetStarted;
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (this.getFailure) {
      const message = this.getFailure;
      this.getFailure = null;
      throw new Error(message);
    }
    if (this.getPause) {
      const pause = this.getPause;
      this.getPause = null;
      pause.started();
      await pause.release;
    }
    if (keys === null) {
      return Object.fromEntries(
        Array.from(this.values, ([key, value]) => [key, structuredClone(value)]),
      );
    }
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requestedKeys.map((key) => [key, structuredClone(this.values.get(key))]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls.push(structuredClone(items));
    if (this.setFailure) {
      const message = this.setFailure;
      this.setFailure = null;
      throw new Error(message);
    }
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    this.removeCalls.push([...requestedKeys]);
    if (this.removeFailure) {
      const message = this.removeFailure;
      this.removeFailure = null;
      throw new Error(message);
    }
    for (const key of requestedKeys) this.values.delete(key);
  }
}
