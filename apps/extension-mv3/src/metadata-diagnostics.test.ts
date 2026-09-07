import { describe, expect, test } from "vitest";
import type { LocatorReplayAttempt } from "@meanthis/replay";
import {
  collectMetadataDiagnosticsDevice,
  deriveCaptureReplayMetadataDiagnosticsV1,
  deriveMetadataDiagnosticsV1,
  METADATA_DIAGNOSTICS_DESKTOP_VIEWPORT_MIN,
  METADATA_DIAGNOSTICS_MAX_REPLAY_ATTEMPTS,
  METADATA_DIAGNOSTICS_MAX_TOUCH_POINTS,
  METADATA_DIAGNOSTICS_MAX_VIEWPORT_WIDTH,
  METADATA_DIAGNOSTICS_TABLET_VIEWPORT_MIN,
  type MetadataDiagnosticsInput,
} from "./metadata-diagnostics";

const VALID_CAPTURE_ID = "capture-metadata-1";
const VALID_OBSERVED_AT = "2026-08-30T00:00:00.000Z";

function attempt(
  overrides: Partial<LocatorReplayAttempt> = {},
): LocatorReplayAttempt {
  return {
    strategy: "css",
    value: "#save",
    replayVerified: false,
    uniqueness: null,
    failureReason: "locator replay adapter failed",
    matchCount: null,
    visible: null,
    ...overrides,
  };
}

function verifiedAttempt(): LocatorReplayAttempt {
  return attempt({
    replayVerified: true,
    uniqueness: true,
    failureReason: null,
    matchCount: 1,
    visible: true,
  });
}

function ambiguousAttempt(): LocatorReplayAttempt {
  return attempt({
    uniqueness: false,
    failureReason: "locator matched 2 elements",
    matchCount: 2,
  });
}

function missingAttempt(): LocatorReplayAttempt {
  return attempt({
    uniqueness: false,
    failureReason: "locator matched 0 elements",
    matchCount: 0,
  });
}

function environment(
  viewportWidth: number,
  coarsePointer?: boolean,
  touchPoints?: number,
): MetadataDiagnosticsInput["environment"] {
  return {
    viewportWidth,
    ...(coarsePointer === undefined ? {} : { coarsePointer }),
    ...(touchPoints === undefined ? {} : { touchPoints }),
  };
}

function input(
  overrides: Partial<MetadataDiagnosticsInput> = {},
): MetadataDiagnosticsInput {
  return {
    optIn: true,
    captureId: VALID_CAPTURE_ID,
    observedAt: VALID_OBSERVED_AT,
    replayAttempts: [],
    environment: {
      viewportWidth: 1024,
      coarsePointer: false,
      touchPoints: 0,
    },
    ...overrides,
  };
}

describe("deriveMetadataDiagnosticsV1", () => {
  test("returns null without touching disabled fields or iterators", () => {
    const disabled = {
      optIn: false,
      get captureId(): never {
        throw new Error("captureId accessed");
      },
      get observedAt(): never {
        throw new Error("observedAt accessed");
      },
      get replayAttempts(): never {
        throw new Error("replayAttempts accessed");
      },
      get environment(): never {
        throw new Error("environment accessed");
      },
    } as unknown as MetadataDiagnosticsInput;

    expect(deriveMetadataDiagnosticsV1(disabled)).toEqual({ ok: true, value: null });
  });

  test("rejects an opt-in accessor without invoking it", () => {
    let getterCalls = 0;
    const guarded = input() as unknown as Record<string, unknown>;
    Object.defineProperty(guarded, "optIn", {
      enumerable: true,
      get(): true {
        getterCalls += 1;
        return true;
      },
    });

    expect(deriveMetadataDiagnosticsV1(guarded as unknown as MetadataDiagnosticsInput)).toEqual({
      ok: false,
      status: "malformed",
    });
    expect(getterCalls).toBe(0);
  });

  test("rejects replay and environment accessors without invoking them", () => {
    let replayGetterCalls = 0;
    let environmentGetterCalls = 0;
    const guarded = {
      optIn: true,
      captureId: VALID_CAPTURE_ID,
      observedAt: VALID_OBSERVED_AT,
    } as Record<string, unknown>;
    Object.defineProperty(guarded, "replayAttempts", {
      enumerable: true,
      get(): never {
        replayGetterCalls += 1;
        throw new Error("replay getter invoked");
      },
    });
    Object.defineProperty(guarded, "environment", {
      enumerable: true,
      get(): never {
        environmentGetterCalls += 1;
        throw new Error("environment getter invoked");
      },
    });

    expect(deriveMetadataDiagnosticsV1(guarded as unknown as MetadataDiagnosticsInput)).toEqual({
      ok: false,
      status: "malformed",
    });
    expect(replayGetterCalls).toBe(0);
    expect(environmentGetterCalls).toBe(0);
  });

  test("rejects nested replay and environment accessors without invoking them", () => {
    let replayFieldGetterCalls = 0;
    let environmentFieldGetterCalls = 0;
    const replayEntry = attempt();
    Object.defineProperty(replayEntry, "replayVerified", {
      enumerable: true,
      get(): never {
        replayFieldGetterCalls += 1;
        throw new Error("replay field getter invoked");
      },
    });
    const environment = { viewportWidth: 1024 } as Record<string, unknown>;
    Object.defineProperty(environment, "touchPoints", {
      enumerable: true,
      get(): never {
        environmentFieldGetterCalls += 1;
        throw new Error("environment field getter invoked");
      },
    });

    expect(deriveMetadataDiagnosticsV1(input({
      replayAttempts: [replayEntry],
      environment: environment as MetadataDiagnosticsInput["environment"],
    }))).toEqual({ ok: false, status: "malformed" });
    expect(replayFieldGetterCalls).toBe(0);
    expect(environmentFieldGetterCalls).toBe(0);
  });

  test("rejects an ignored locator accessor without invoking it", () => {
    let getterCalls = 0;
    const replayEntry = ambiguousAttempt() as unknown as Record<string, unknown>;
    Object.defineProperty(replayEntry, "value", {
      enumerable: true,
      get(): string {
        getterCalls += 1;
        return "SECRET_SELECTOR";
      },
    });

    expect(deriveMetadataDiagnosticsV1(input({
      replayAttempts: [replayEntry as unknown as LocatorReplayAttempt],
    }))).toEqual({ ok: false, status: "malformed" });
    expect(getterCalls).toBe(0);
  });

  test("rejects non-plain, non-enumerable, extra, and own-undefined records", () => {
    const nonPlainTop = Object.assign(Object.create({ inherited: true }), input());
    expect(deriveMetadataDiagnosticsV1(nonPlainTop)).toEqual({ ok: false, status: "malformed" });

    const hiddenCaptureId = input() as unknown as Record<string, unknown>;
    Object.defineProperty(hiddenCaptureId, "captureId", {
      enumerable: false,
      value: VALID_CAPTURE_ID,
    });
    expect(deriveMetadataDiagnosticsV1(
      hiddenCaptureId as unknown as MetadataDiagnosticsInput,
    )).toEqual({ ok: false, status: "malformed" });

    expect(deriveMetadataDiagnosticsV1({
      ...input(),
      extra: true,
    } as unknown as MetadataDiagnosticsInput)).toEqual({ ok: false, status: "malformed" });

    const nonPlainEnvironment = Object.assign(Object.create({ inherited: true }), {
      viewportWidth: 1024,
    });
    expect(deriveMetadataDiagnosticsV1(input({
      environment: nonPlainEnvironment,
    }))).toEqual({ ok: false, status: "malformed" });

    const hiddenViewport = {} as Record<string, unknown>;
    Object.defineProperty(hiddenViewport, "viewportWidth", {
      enumerable: false,
      value: 1024,
    });
    expect(deriveMetadataDiagnosticsV1(input({
      environment: hiddenViewport as unknown as MetadataDiagnosticsInput["environment"],
    }))).toEqual({ ok: false, status: "malformed" });

    expect(deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth: 1024, extra: true } as unknown as MetadataDiagnosticsInput["environment"],
    }))).toEqual({ ok: false, status: "malformed" });
    expect(deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth: 1024, touchPoints: undefined },
    }))).toEqual({ ok: false, status: "malformed" });
  });

  test("uses one exact descriptor snapshot and rejects symbol extras", () => {
    let ownKeysCalls = 0;
    let getCalls = 0;
    const proxied = new Proxy(input(), {
      get(target, key, receiver) {
        getCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(deriveMetadataDiagnosticsV1(proxied).ok).toBe(true);
    expect(ownKeysCalls).toBe(1);
    expect(getCalls).toBe(0);

    const topSymbol = input();
    Object.defineProperty(topSymbol, Symbol("extra"), { enumerable: true, value: true });
    expect(deriveMetadataDiagnosticsV1(topSymbol)).toEqual({ ok: false, status: "malformed" });

    const attemptSymbol = ambiguousAttempt();
    Object.defineProperty(attemptSymbol, Symbol("extra"), { enumerable: true, value: true });
    expect(deriveMetadataDiagnosticsV1(input({ replayAttempts: [attemptSymbol] }))).toEqual({
      ok: false,
      status: "malformed",
    });

    const arraySymbol = [ambiguousAttempt()];
    Object.defineProperty(arraySymbol, Symbol("extra"), { enumerable: true, value: true });
    expect(deriveMetadataDiagnosticsV1(input({ replayAttempts: arraySymbol }))).toEqual({
      ok: false,
      status: "malformed",
    });
  });

  test("rejects sparse or extended arrays and incomplete production attempts", () => {
    const sparse = new Array<LocatorReplayAttempt>(1);
    expect(deriveMetadataDiagnosticsV1(input({ replayAttempts: sparse }))).toEqual({
      ok: false,
      status: "malformed",
    });

    const extended = [ambiguousAttempt()] as LocatorReplayAttempt[] & { extra?: boolean };
    extended.extra = true;
    expect(deriveMetadataDiagnosticsV1(input({ replayAttempts: extended }))).toEqual({
      ok: false,
      status: "malformed",
    });

    for (const key of [
      "strategy",
      "value",
      "replayVerified",
      "uniqueness",
      "failureReason",
      "matchCount",
      "visible",
    ] as const) {
      const incomplete = { ...ambiguousAttempt() } as Record<string, unknown>;
      delete incomplete[key];
      expect(deriveMetadataDiagnosticsV1(input({
        replayAttempts: [incomplete as unknown as LocatorReplayAttempt],
      })), key).toEqual({ ok: false, status: "malformed" });
    }
  });

  test("collects zero attempts with explicit capture-time and all-false authority", () => {
    const result = deriveMetadataDiagnosticsV1(input());

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: "0.1.0",
        kind: "ui-attach.metadata-only-diagnostics",
        captureId: VALID_CAPTURE_ID,
        scope: "capture",
        observedAt: VALID_OBSERVED_AT,
        consent: "explicit_capture",
        authority: "capture_time",
        replay: {
          status: "collected",
          attemptCount: 0,
          verifiedCount: 0,
          ambiguousCount: 0,
          missingCount: 0,
        },
        device: {
          status: "collected",
          deviceClass: "tablet",
          viewportClass: "medium",
          touch: "none",
        },
        network: { status: "not_requested" },
        console: { status: "not_requested" },
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
      },
    });
  });

  test("aggregates only production replay result fields", () => {
    const result = deriveMetadataDiagnosticsV1(input({
      replayAttempts: [
        verifiedAttempt(),
        ambiguousAttempt(),
        missingAttempt(),
      ],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) return;
    expect(result.value.replay).toEqual({
      status: "collected",
      attemptCount: 3,
      verifiedCount: 1,
      ambiguousCount: 1,
      missingCount: 1,
    });
  });

  test("does not reflect forbidden replay strings in output", () => {
    const result = deriveMetadataDiagnosticsV1(input({
      replayAttempts: [
        attempt({
          replayVerified: false,
          uniqueness: null,
          matchCount: null,
          value: "SECRET_SELECTOR",
          failureReason: "SECRET_REASON",
        }),
      ],
    }));

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_SELECTOR");
    expect(JSON.stringify(result)).not.toContain("SECRET_REASON");
  });

  test.each([
    ["malformed replay entry", { replayAttempts: [null] }],
    ["malformed replay field", { replayAttempts: [attempt({ matchCount: -1 })] }],
    ["overbound replay attempts", {
      replayAttempts: Array.from({ length: METADATA_DIAGNOSTICS_MAX_REPLAY_ATTEMPTS + 1 }, () =>
        attempt()),
    }],
  ])("fails closed for %s", (_label, overrides) => {
    const result = deriveMetadataDiagnosticsV1(input(overrides as Partial<MetadataDiagnosticsInput>));
    expect(result).toEqual({
      ok: false,
      status: _label === "overbound replay attempts" ? "overbound" : "malformed",
    });
    expect(JSON.stringify(result)).not.toContain("#save");
  });

  test.each([
    ["zero width", 0, "malformed"],
    ["fractional width", 767.5, "malformed"],
    ["non-finite width", Number.POSITIVE_INFINITY, "malformed"],
    ["overbound width", METADATA_DIAGNOSTICS_MAX_VIEWPORT_WIDTH + 1, "overbound"],
  ] as const)("fails closed for %s", (_label, viewportWidth, status) => {
    const result = deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth },
    }));
    expect(result).toEqual({ ok: false, status });
  });

  test("rejects malformed pointer and touch facts without exposing dimensions", () => {
    expect(deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth: 1024, coarsePointer: "yes" as unknown as boolean },
    }))).toEqual({ ok: false, status: "malformed" });
    expect(deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth: 1024, touchPoints: -1 },
    }))).toEqual({ ok: false, status: "malformed" });
    expect(JSON.stringify(deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth: 1024, touchPoints: -1 },
    })))).not.toContain("1024");
    expect(deriveMetadataDiagnosticsV1(input({
      environment: {
        viewportWidth: 1024,
        touchPoints: METADATA_DIAGNOSTICS_MAX_TOUCH_POINTS + 1,
      },
    }))).toEqual({ ok: false, status: "overbound" });
  });

  test.each([
    [METADATA_DIAGNOSTICS_TABLET_VIEWPORT_MIN - 1, "mobile", "small"],
    [METADATA_DIAGNOSTICS_TABLET_VIEWPORT_MIN, "tablet", "medium"],
    [METADATA_DIAGNOSTICS_DESKTOP_VIEWPORT_MIN - 1, "tablet", "medium"],
    [METADATA_DIAGNOSTICS_DESKTOP_VIEWPORT_MIN, "desktop", "large"],
  ] as const)("classifies coarse viewport boundary %i", (viewportWidth, deviceClass, viewportClass) => {
    const result = deriveMetadataDiagnosticsV1(input({
      environment: { viewportWidth },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) return;
    expect(result.value.device).toEqual({
      status: "collected",
      deviceClass,
      viewportClass,
      touch: "unknown",
    });
  });

  test.each([
    [{ coarsePointer: true, touchPoints: 0 }, "coarse"],
    [{ coarsePointer: false, touchPoints: 1 }, "coarse"],
    [{ coarsePointer: false, touchPoints: 0 }, "none"],
    [{}, "unknown"],
  ] as const)("classifies touch as %s", (touchInput, touch) => {
    const result = deriveMetadataDiagnosticsV1(input({
      environment: environment(1024, touchInput.coarsePointer, touchInput.touchPoints),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) return;
    expect(result.value.device.touch).toBe(touch);
  });

  test("is deterministic for identical production input", () => {
    const value = input({
      replayAttempts: [verifiedAttempt()],
      environment: { viewportWidth: 1200, coarsePointer: true, touchPoints: 5 },
    });

    expect(deriveMetadataDiagnosticsV1(value)).toEqual(deriveMetadataDiagnosticsV1(value));
  });
});

describe("deriveCaptureReplayMetadataDiagnosticsV1", () => {
  test("aggregates only existing replay facts and leaves new observation domains unrequested", () => {
    const result = deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: "session-1",
      observedAt: VALID_OBSERVED_AT,
      replayAttemptGroups: [
        [verifiedAttempt(), ambiguousAttempt()],
        [missingAttempt(), attempt()],
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: "0.1.0",
        kind: "ui-attach.metadata-only-diagnostics",
        captureId: "session-1",
        scope: "capture",
        observedAt: VALID_OBSERVED_AT,
        consent: "explicit_capture",
        authority: "capture_time",
        replay: {
          status: "collected",
          attemptCount: 4,
          verifiedCount: 1,
          ambiguousCount: 1,
          missingCount: 1,
        },
        device: { status: "not_requested" },
        network: { status: "not_requested" },
        console: { status: "not_requested" },
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("#save");
    expect(JSON.stringify(result)).not.toContain("locator replay adapter failed");
  });

  test("reports unavailable, malformed, and overbound replay without inventing partial metrics", () => {
    const unavailable = deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: "session-1",
      observedAt: VALID_OBSERVED_AT,
      replayAttemptGroups: [undefined],
    });
    expect(unavailable).toMatchObject({ ok: true, value: { replay: { status: "not_available" } } });

    const malformed = deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: "session-1",
      observedAt: VALID_OBSERVED_AT,
      replayAttemptGroups: [[{ ...verifiedAttempt(), replayVerified: "yes" }]],
    });
    expect(malformed).toMatchObject({ ok: true, value: { replay: { status: "malformed" } } });

    const overbound = deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: "session-1",
      observedAt: VALID_OBSERVED_AT,
      replayAttemptGroups: [
        Array.from({ length: METADATA_DIAGNOSTICS_MAX_REPLAY_ATTEMPTS }, verifiedAttempt),
        [verifiedAttempt()],
      ],
    });
    expect(overbound).toMatchObject({ ok: true, value: { replay: { status: "overbound" } } });
    expect((overbound as { value: { replay: object } }).value.replay).toEqual({ status: "overbound" });
  });

  test("rejects hostile top-level fields and never invokes nested accessors", () => {
    let getterCalls = 0;
    const replay = verifiedAttempt() as unknown as Record<string, unknown>;
    Object.defineProperty(replay, "matchCount", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    const nested = deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: "session-1",
      observedAt: VALID_OBSERVED_AT,
      replayAttemptGroups: [[replay]],
    });
    expect(nested).toMatchObject({ ok: true, value: { replay: { status: "malformed" } } });
    expect(getterCalls).toBe(0);

    expect(deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: "session-1",
      observedAt: VALID_OBSERVED_AT,
      replayAttemptGroups: [],
      extra: true,
    } as never)).toEqual({ ok: false, status: "malformed" });
  });
});

describe("collectMetadataDiagnosticsDevice", () => {
  test("reads the selected target ownerDocument frame, not a global-like view", () => {
    let globalLikeMatchMediaCalls = 0;
    let frameMatchMediaQuery: string | null = null;
    const globalLikeView = {
      innerWidth: 320,
      matchMedia: () => {
        globalLikeMatchMediaCalls += 1;
        return { matches: false };
      },
      navigator: { maxTouchPoints: 0 },
    };
    const frameView = {
      innerWidth: 1440,
      matchMedia: (query: string) => {
        frameMatchMediaQuery = query;
        return { matches: true };
      },
      navigator: { maxTouchPoints: 0 },
      userAgent: "SECRET_FRAME_UA",
      location: { href: "https://secret.example/frame" },
      path: "C:\\secret\\frame",
    };
    const target = {
      ownerDocument: {
        defaultView: frameView,
        documentElement: { clientWidth: 1200 },
      },
    } as unknown as HTMLElement;

    const result = collectMetadataDiagnosticsDevice(target);

    expect(result).toEqual({
      status: "collected",
      deviceClass: "desktop",
      viewportClass: "large",
      touch: "coarse",
    });
    expect(frameMatchMediaQuery).toBe("(pointer: coarse)");
    expect(globalLikeMatchMediaCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("SECRET_FRAME_UA");
    expect(JSON.stringify(result)).not.toContain("https://secret.example/frame");
    expect(JSON.stringify(result)).not.toContain("C:\\secret\\frame");
  });

  test("uses the frame innerWidth only when documentElement.clientWidth is unavailable", () => {
    const view = {
      innerWidth: 768,
      matchMedia: () => ({ matches: false }),
      navigator: { maxTouchPoints: 0 },
    };
    const target = {
      ownerDocument: {
        defaultView: view,
        documentElement: { clientWidth: 0 },
      },
    } as unknown as HTMLElement;

    expect(collectMetadataDiagnosticsDevice(target)).toEqual({
      status: "collected",
      deviceClass: "tablet",
      viewportClass: "medium",
      touch: "none",
    });
  });

  test.each([
    ["null target", null],
    ["missing ownerDocument", {}],
    ["missing defaultView", { ownerDocument: {} }],
    ["null defaultView", { ownerDocument: { defaultView: null } }],
    ["missing matchMedia", {
      ownerDocument: {
        defaultView: { innerWidth: 1024, navigator: { maxTouchPoints: 0 } },
        documentElement: { clientWidth: 1024 },
      },
    }],
    ["missing navigator", {
      ownerDocument: {
        defaultView: { innerWidth: 1024, matchMedia: () => ({ matches: false }) },
        documentElement: { clientWidth: 1024 },
      },
    }],
    ["zero width", {
      ownerDocument: {
        defaultView: {
          innerWidth: 0,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: { clientWidth: 0 },
      },
    }],
    ["negative width", {
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: { clientWidth: -1 },
      },
    }],
  ])("returns not_available for %s", (_label, value) => {
    expect(collectMetadataDiagnosticsDevice(value as HTMLElement | null)).toEqual({
      status: "not_available",
    });
  });

  test.each([
    ["ownerDocument getter", () => {
      const target = {} as Record<string, unknown>;
      Object.defineProperty(target, "ownerDocument", {
        get: () => {
          throw new Error("SECRET_URL https://secret.example");
        },
      });
      return target;
    }],
    ["defaultView getter", () => ({
      ownerDocument: Object.defineProperty({}, "defaultView", {
        get: () => {
          throw new Error("SECRET_PATH C:\\secret");
        },
      }),
    })],
    ["documentElement getter", () => ({
      ownerDocument: Object.defineProperty({
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: 0 },
        },
      }, "documentElement", {
        get: () => {
          throw new Error("SECRET_UA Mozilla/5.0");
        },
      }),
    })],
    ["clientWidth getter", () => ({
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: Object.defineProperty({}, "clientWidth", {
          get: () => {
            throw new Error("SECRET_URL");
          },
        }),
      },
    })],
    ["innerWidth getter", () => ({
      ownerDocument: {
        defaultView: Object.defineProperty({
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: 0 },
        }, "innerWidth", {
          get: () => {
            throw new Error("SECRET_PATH");
          },
        }),
        documentElement: { clientWidth: 0 },
      },
    })],
    ["matchMedia throw", () => ({
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => {
            throw new Error("SECRET_UA");
          },
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: { clientWidth: 1024 },
      },
    })],
    ["matches getter", () => ({
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => Object.defineProperty({}, "matches", {
            get: () => {
              throw new Error("SECRET_URL");
            },
          }),
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: { clientWidth: 1024 },
      },
    })],
    ["navigator getter", () => ({
      ownerDocument: {
        defaultView: Object.defineProperty({
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
        }, "navigator", {
          get: () => {
            throw new Error("SECRET_PATH");
          },
        }),
        documentElement: { clientWidth: 1024 },
      },
    })],
    ["maxTouchPoints getter", () => ({
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: Object.defineProperty({}, "maxTouchPoints", {
            get: () => {
              throw new Error("SECRET_UA");
            },
          }),
        },
        documentElement: { clientWidth: 1024 },
      },
    })],
  ])("fails closed without echoing %s", (_label, createTarget) => {
    const result = collectMetadataDiagnosticsDevice(
      createTarget() as unknown as HTMLElement,
    );
    expect(result).toEqual({ status: "not_available" });
    expect(JSON.stringify(result)).not.toContain("SECRET_");
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(JSON.stringify(result)).not.toContain("C:\\");
    expect(JSON.stringify(result)).not.toContain("Mozilla");
  });

  test.each([
    ["overbound viewport", {
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: { clientWidth: METADATA_DIAGNOSTICS_MAX_VIEWPORT_WIDTH + 1 },
      },
    }],
    ["overbound touch points", {
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: METADATA_DIAGNOSTICS_MAX_TOUCH_POINTS + 1 },
        },
        documentElement: { clientWidth: 1024 },
      },
    }],
  ])("preserves the existing %s boundary", (_label, value) => {
    expect(collectMetadataDiagnosticsDevice(value as unknown as HTMLElement)).toEqual({
      status: "overbound",
    });
  });

  test.each([
    ["malformed pointer match", {
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: "yes" }),
          navigator: { maxTouchPoints: 0 },
        },
        documentElement: { clientWidth: 1024 },
      },
    }],
    ["malformed touch points", {
      ownerDocument: {
        defaultView: {
          innerWidth: 1024,
          matchMedia: () => ({ matches: false }),
          navigator: { maxTouchPoints: "two" },
        },
        documentElement: { clientWidth: 1024 },
      },
    }],
  ])("returns malformed for %s", (_label, value) => {
    expect(collectMetadataDiagnosticsDevice(value as unknown as HTMLElement)).toEqual({
      status: "malformed",
    });
  });

  test("returns the exact coarse shape and never copies raw environment strings", () => {
    const rawUserAgent = "SECRET_USER_AGENT";
    const rawUrl = "https://secret.example/path?query=1";
    const rawPath = "C:\\fixture-private\\secret\\path";
    const rawTouchPoints = "SECRET_RAW_TOUCH_POINTS";
    const view = {
      innerWidth: 1024,
      userAgent: rawUserAgent,
      location: { href: rawUrl },
      path: rawPath,
      touchPoints: rawTouchPoints,
      matchMedia: () => ({ matches: false }),
      navigator: {
        maxTouchPoints: 2,
        userAgent: rawUserAgent,
        location: rawUrl,
        path: rawPath,
        touchPoints: rawTouchPoints,
      },
    };
    const target = {
      ownerDocument: {
        defaultView: view,
        documentElement: { clientWidth: 1024 },
      },
    } as unknown as HTMLElement;

    const result = collectMetadataDiagnosticsDevice(target);

    expect(result).toEqual({
      status: "collected",
      deviceClass: "tablet",
      viewportClass: "medium",
      touch: "coarse",
    });
    expect(Object.keys(result).sort()).toEqual([
      "deviceClass",
      "status",
      "touch",
      "viewportClass",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawUserAgent);
    expect(serialized).not.toContain(rawUrl);
    expect(serialized).not.toContain(rawPath);
    expect(serialized).not.toContain(rawTouchPoints);
    expect(serialized).not.toContain("1024");
    expect(serialized).not.toContain("2");
  });

  test("does not read the target until the collector is called", () => {
    let ownerDocumentReads = 0;
    const target = {} as Record<string, unknown>;
    Object.defineProperty(target, "ownerDocument", {
      get: () => {
        ownerDocumentReads += 1;
        return null;
      },
    });

    expect(ownerDocumentReads).toBe(0);
    expect(collectMetadataDiagnosticsDevice(target as unknown as HTMLElement)).toEqual({
      status: "not_available",
    });
    expect(ownerDocumentReads).toBe(1);
  });
});
