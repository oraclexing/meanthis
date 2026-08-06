// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import type { ContextCaptureResult } from "./capture";
import type { ActiveSessionReadback } from "./session-store";
import type { CaptureToken } from "./session-state";
import {
  createTestClickCaptureController as createRawTestClickCaptureController,
  type TestClickCaptureControllerOptions,
} from "./test-click-capture";
import { createSelectionLifecycleController } from "./selection-lifecycle";

const TOKEN: CaptureToken = {
  origin: "https://app.example.test",
  epoch: "epoch-1",
  operationId: "op-1",
};
const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";
const SECRET = "sk-test-1234567890";

function createTestClickCaptureController(
  options: TestClickCaptureControllerOptions,
) {
  return createRawTestClickCaptureController({
    ...options,
    isTrustedClickEvent: () => true,
  });
}

describe("createTestClickCaptureController", () => {
  test("seeds the right-clicked target as preview without capturing until confirmation", async () => {
    document.body.innerHTML = [
      '<button id="save">Save changes</button>',
      '<button id="cancel">Cancel</button>',
    ].join("");
    const save = requireButton("#save");
    const cancel = requireButton("#cancel");
    const previews: Array<HTMLElement | null> = [];
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      previewTarget: (target) => previews.push(target),
      disableSelection: async () => {},
    });

    expect(controller.seedPreview(save)).toBe(false);
    expect(previews).toEqual([]);
    expect(beginCapture).not.toHaveBeenCalled();

    controller.setEnabled(true);
    expect(controller.seedPreview(save)).toBe(true);
    expect(previews).toEqual([save]);
    expect(beginCapture).not.toHaveBeenCalled();

    cancel.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(previews).toEqual([save, cancel]);
    expect(beginCapture).not.toHaveBeenCalled();

    const detached = document.createElement("button");
    expect(controller.seedPreview(detached)).toBe(false);
    controller.requestDisable();
    expect(controller.seedPreview(save)).toBe(false);
    await flushAsyncWork();
    expect(beginCapture).not.toHaveBeenCalled();

    controller.dispose();
  });

  test("previews selectable targets only while selection is enabled", async () => {
    document.body.innerHTML = '<button id="save"><span>Save changes</span></button>';
    const button = requireButton("#save");
    const label = button.querySelector("span");
    const previews: Array<HTMLElement | null> = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      previewTarget: (target) => previews.push(target),
      disableSelection: async () => {},
    });

    label?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(previews).toEqual([]);

    controller.setEnabled(true);
    label?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(previews).toEqual([button]);

    button.click();
    await flushAsyncWork();
    expect(previews.at(-1)).toBeNull();

    controller.setEnabled(false);
    controller.dispose();
    expect(previews.at(-1)).toBeNull();
  });

  test("Escape suppresses the page shortcut and disables persistent selection", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const disableSelection = vi.fn(async () => {});
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const previewTarget = vi.fn();
    const pageShortcut = vi.fn();
    document.addEventListener("keydown", pageShortcut);
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      previewTarget,
      disableSelection,
      isTrustedKeyEvent: () => true,
    });
    controller.setEnabled(true);
    expect(controller.seedPreview(button)).toBe(true);

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(escape);
    await flushAsyncWork();

    expect(escape.defaultPrevented).toBe(true);
    expect(pageShortcut).not.toHaveBeenCalled();
    expect(disableSelection).toHaveBeenCalledOnce();
    expect(beginCapture).not.toHaveBeenCalled();
    expect(controller.isEnabled()).toBe(false);
    expect(previewTarget).toHaveBeenLastCalledWith(null);
    document.removeEventListener("keydown", pageShortcut);
    controller.dispose();
  });

  test("navigation disables locally and requests background revocation", async () => {
    const disableSelection = vi.fn(async () => {});
    const previewTarget = vi.fn();
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      previewTarget,
      disableSelection,
    });
    controller.setEnabled(true);

    controller.disableForNavigation();
    await flushAsyncWork();

    expect(disableSelection).toHaveBeenCalledOnce();
    expect(controller.isEnabled()).toBe(false);
    expect(previewTarget).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  test("navigation disables locally even when the background revoke fails", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const pageAction = vi.fn();
    button.addEventListener("click", pageAction);
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      disableSelection: async () => { throw new Error("worker restarted"); },
    });
    controller.setEnabled(true);

    controller.disableForNavigation();
    button.click();
    await flushAsyncWork();

    expect(controller.isEnabled()).toBe(false);
    expect(pageAction).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test("worker lifecycle disconnect disables stale selection before the next page click", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const pageAction = vi.fn();
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    let disconnectListener: (() => void) | undefined;
    button.addEventListener("click", pageAction);
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });
    const lifecycle = createSelectionLifecycleController({
      connect: () => ({
        disconnect: vi.fn(),
        onDisconnect: {
          addListener: (listener) => { disconnectListener = listener; },
        },
      }),
      onDisconnect: () => controller.setEnabled(false),
    });
    controller.setEnabled(true);
    expect(lifecycle.arm()).toBe(true);

    disconnectListener?.();
    button.click();
    await flushAsyncWork();

    expect(controller.isEnabled()).toBe(false);
    expect(pageAction).toHaveBeenCalledOnce();
    expect(beginCapture).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("ignores a synthetic Escape from the page", async () => {
    const disableSelection = vi.fn(async () => {});
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      disableSelection,
    });
    controller.setEnabled(true);

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    await flushAsyncWork();

    expect(disableSelection).not.toHaveBeenCalled();
    expect(controller.isEnabled()).toBe(true);
    controller.dispose();
  });

  test("ignores a synthetic page click while selection is enabled", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const captureTarget = vi.fn(async () => createCaptureResult());
    const pageAction = vi.fn();
    button.addEventListener("click", pageAction);
    const controller = createRawTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget,
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });
    controller.setEnabled(true);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    await flushAsyncWork();

    expect(event.defaultPrevented).toBe(false);
    expect(pageAction).toHaveBeenCalledOnce();
    expect(captureTarget).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("keeps selection authoritative when Escape persistence fails", async () => {
    const failures: string[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async (error) => failures.push(error),
      publishCommitted: async () => {},
      disableSelection: async () => { throw new Error("storage unavailable"); },
      isTrustedKeyEvent: () => true,
    });
    controller.setEnabled(true);

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    await flushAsyncWork();

    expect(controller.isEnabled()).toBe(true);
    expect(failures).toEqual([SAFE_CAPTURE_ERROR]);
    controller.dispose();
  });

  test("captures page clicks only after test mode is enabled", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = document.querySelector("#save");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("fixture button missing");
    }

    const capturedTargets: HTMLElement[] = [];
    const committedTargets: Array<{ target: HTMLElement; itemId: string }> = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        capturedTargets.push(target);
        return createCaptureResult();
      },
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async (target, receipt) => {
        committedTargets.push({ target, itemId: receipt.itemId });
      },
    });

    button.click();
    await flushAsyncWork();

    expect(capturedTargets).toEqual([]);
    expect(committedTargets).toEqual([]);

    controller.setEnabled(true);
    button.click();
    await flushAsyncWork();

    expect(capturedTargets).toEqual([button]);
    expect(committedTargets).toEqual([{ target: button, itemId: "att_save" }]);
    controller.dispose();
  });

  test("captures the same live element once while suppressing every selection click", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button><button id="cancel">Cancel</button>';
    const save = requireButton("#save");
    const cancel = requireButton("#cancel");
    const committedTargets = new Set<HTMLElement>();
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const captureTarget = vi.fn(async () => createCaptureResult());
    const commitCapture = vi.fn(async () => ({ ok: true as const, data: createReceipt() }));
    const publishCommitted = vi.fn(async (target: HTMLElement) => {
      committedTargets.add(target);
    });
    const pageAction = vi.fn();
    save.addEventListener("click", pageAction);
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget,
      commitCapture,
      publishFailure: async () => {},
      publishCommitted,
      isTargetCommitted: (target) => committedTargets.has(target),
    });
    const firstClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    const duplicateClick = new MouseEvent("click", { bubbles: true, cancelable: true });

    controller.setEnabled(true);
    save.dispatchEvent(firstClick);
    save.dispatchEvent(duplicateClick);
    cancel.click();
    await flushAsyncWork();
    controller.dispose();

    expect(firstClick.defaultPrevented).toBe(true);
    expect(duplicateClick.defaultPrevented).toBe(true);
    expect(pageAction).not.toHaveBeenCalled();
    expect(beginCapture).toHaveBeenCalledTimes(2);
    expect(captureTarget).toHaveBeenCalledTimes(2);
    expect(commitCapture).toHaveBeenCalledTimes(2);
    expect(publishCommitted).toHaveBeenCalledTimes(2);
  });

  test("captures a pointer gesture once even when its following click is delayed", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const save = requireButton("#save");
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const pageAction = vi.fn();
    save.addEventListener("click", pageAction);
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      isTrustedClickEvent: () => true,
    });
    const pointerDown = createPointerDown();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    controller.setEnabled(true);
    save.dispatchEvent(pointerDown);
    await vi.advanceTimersByTimeAsync(2_000);
    save.dispatchEvent(click);
    await vi.runAllTimersAsync();

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(pageAction).not.toHaveBeenCalled();
    expect(beginCapture).toHaveBeenCalledOnce();
    controller.dispose();
    vi.useRealTimers();
  });

  test("ignores secondary, non-primary, and touch pointerdown gestures", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const save = requireButton("#save");
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      isTrustedClickEvent: () => true,
    });
    const secondary = createPointerDown({ button: 2 });
    const nonPrimary = createPointerDown({ isPrimary: false });
    const touch = createPointerDown({ pointerType: "touch" });

    controller.setEnabled(true);
    save.dispatchEvent(secondary);
    save.dispatchEvent(nonPrimary);
    save.dispatchEvent(touch);
    await flushAsyncWork();
    controller.dispose();

    expect(secondary.defaultPrevented).toBe(false);
    expect(nonPrimary.defaultPrevented).toBe(false);
    expect(touch.defaultPrevented).toBe(false);
    expect(beginCapture).not.toHaveBeenCalled();
  });

  test("does not recapture an exact live element restored from the current session", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const save = requireButton("#save");
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const pageAction = vi.fn();
    save.addEventListener("click", pageAction);
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReceipt() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      isTargetCommitted: (target) => target === save,
    });
    const repeatedClick = new MouseEvent("click", { bubbles: true, cancelable: true });

    controller.setEnabled(true);
    save.dispatchEvent(repeatedClick);
    await flushAsyncWork();
    controller.dispose();

    expect(repeatedClick.defaultPrevented).toBe(true);
    expect(pageAction).not.toHaveBeenCalled();
    expect(beginCapture).not.toHaveBeenCalled();
  });

  test("captures and publishes the button for a click on its nested label", async () => {
    document.body.innerHTML = '<button id="search"><span>Search</span></button>';
    const button = requireButton("#search");
    const nestedLabel = button.querySelector("span");
    const capturedTargets: HTMLElement[] = [];
    const committedTargets: HTMLElement[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        capturedTargets.push(target);
        return createCaptureResult();
      },
      commitCapture: async () => ({ ok: true, data: createReadback() }),
      publishFailure: async () => {},
      publishCommitted: async (target) => {
        committedTargets.push(target);
      },
    });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    controller.setEnabled(true);
    nestedLabel?.dispatchEvent(event);
    await flushAsyncWork();

    expect(event.defaultPrevented).toBe(true);
    expect(capturedTargets).toEqual([button]);
    expect(committedTargets).toEqual([button]);
    controller.dispose();
  });

  test("captures the composed control inside an open shadow root", async () => {
    document.body.innerHTML = '<div id="shadow-host"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Save shadow changes";
    shadowRoot.append(button);
    const capturedTargets: HTMLElement[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        capturedTargets.push(target);
        return createCaptureResult();
      },
      commitCapture: async () => ({ ok: true, data: createReadback() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });

    controller.setEnabled(true);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await flushAsyncWork();

    expect(capturedTargets).toEqual([button]);
    controller.dispose();
  });

  test("ignores a composed shadow control inside an ignored host", async () => {
    document.body.innerHTML = '<div id="shadow-host" data-ui-attach-ignore="true"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("ignored shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    shadowRoot.append(button);
    const capturedTargets: HTMLElement[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        capturedTargets.push(target);
        return createCaptureResult();
      },
      commitCapture: async () => ({ ok: true, data: createReadback() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });

    controller.setEnabled(true);
    const event = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    button.dispatchEvent(event);
    await flushAsyncWork();

    expect(capturedTargets).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    controller.dispose();
  });

  test("suppresses accepted test capture clicks before page actions run", async () => {
    document.body.innerHTML = '<button id="delete">Delete</button>';
    const button = requireButton("#delete");
    const capturedTargets: HTMLElement[] = [];
    let pageActionCalls = 0;
    button.addEventListener("click", () => {
      pageActionCalls += 1;
    });
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        capturedTargets.push(target);
        return createCaptureResult();
      },
      commitCapture: async () => ({ ok: true, data: createReadback() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    controller.setEnabled(true);
    const dispatchResult = button.dispatchEvent(event);
    await flushAsyncWork();

    expect(event.defaultPrevented).toBe(true);
    expect(dispatchResult).toBe(false);
    expect(pageActionCalls).toBe(0);
    expect(capturedTargets).toEqual([button]);
    controller.dispose();
  });

  test("blocks later delegated document handlers for an accepted test capture click", async () => {
    document.body.innerHTML = '<button id="delete">Delete</button>';
    const button = requireButton("#delete");
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => createCaptureResult(),
      commitCapture: async () => ({ ok: true, data: createReadback() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });
    const pageAction = vi.fn();
    document.addEventListener("click", pageAction, { capture: true });

    controller.setEnabled(true);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushAsyncWork();

    document.removeEventListener("click", pageAction, { capture: true });
    controller.dispose();
    expect(pageAction).not.toHaveBeenCalled();
  });

  test("ignores page root elements and explicit ui-attach controls", async () => {
    document.body.innerHTML = '<button data-ui-attach-ignore="true">Internal</button>';
    const ignored = document.querySelector("button");
    if (!(ignored instanceof HTMLButtonElement)) {
      throw new Error("fixture ignored button missing");
    }

    const capturedTargets: HTMLElement[] = [];
    let pageActionCalls = 0;
    ignored.addEventListener("click", () => {
      pageActionCalls += 1;
    });
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        capturedTargets.push(target);
        return createCaptureResult();
      },
      commitCapture: async () => ({ ok: true, data: createReadback() }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
    });

    controller.setEnabled(true);
    document.body.click();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const dispatchResult = ignored.dispatchEvent(event);
    await flushAsyncWork();

    expect(capturedTargets).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(dispatchResult).toBe(true);
    expect(pageActionCalls).toBe(1);
    controller.dispose();
  });

  test("does not extract when begin is rejected and publishes the safe failure", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const calls: string[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => {
        calls.push("begin");
        return { ok: false, code: "SESSION_FULL", error: "Capture session already contains 26 items." };
      },
      captureTarget: async () => {
        calls.push("capture");
        return createCaptureResult();
      },
      commitCapture: async () => {
        calls.push("commit");
        return { ok: true, data: createReadback() };
      },
      publishFailure: async (error) => {
        calls.push(`failure:${error}`);
      },
      publishCommitted: async () => {
        calls.push("committed");
      },
    });

    controller.setEnabled(true);
    button.click();
    await flushAsyncWork();

    expect(calls).toEqual(["begin", "failure:Capture session already contains 26 items."]);
    controller.dispose();
  });

  test("orders begin extract and a single commit before publishing committed", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const calls: string[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => {
        calls.push("begin");
        return { ok: true, data: TOKEN };
      },
      captureTarget: async () => {
        calls.push("capture");
        return createCaptureResult();
      },
      commitCapture: async (token) => {
        calls.push(`commit:${token.operationId}`);
        return { ok: true, data: createReadback() };
      },
      publishFailure: async (error) => {
        calls.push(`failure:${error}`);
      },
      publishCommitted: async (target) => {
        calls.push(`committed:${target.id}`);
      },
    });

    controller.setEnabled(true);
    button.click();
    await flushAsyncWork();

    expect(calls).toEqual(["begin", "capture", "commit:op-1", "committed:save"]);
    controller.dispose();
  });

  test("serializes rapid accepted clicks so committed overlays keep capture order", async () => {
    document.body.innerHTML = '<button id="save">Save</button><button id="cancel">Cancel</button>';
    const save = requireButton("#save");
    const cancel = requireButton("#cancel");
    const firstCommit = deferred<ReturnType<typeof createSuccessfulCommit>>();
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const captureTarget = vi.fn(async () => createCaptureResult());
    const commitCapture = vi.fn()
      .mockImplementationOnce(async () => firstCommit.promise)
      .mockImplementationOnce(async () => createSuccessfulCommit("att_cancel", "B"));
    const committed: string[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture,
      captureTarget,
      commitCapture,
      publishFailure: async () => {},
      publishCommitted: async (target, receipt) => {
        committed.push(`${receipt.label}:${target.id}`);
      },
    });

    controller.setEnabled(true);
    save.click();
    cancel.click();
    await flushAsyncWork();

    expect(beginCapture).toHaveBeenCalledTimes(1);
    expect(captureTarget).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([]);

    firstCommit.resolve(createSuccessfulCommit("att_save", "A"));
    await flushAsyncWork();

    expect(beginCapture).toHaveBeenCalledTimes(2);
    expect(captureTarget).toHaveBeenCalledTimes(2);
    expect(committed).toEqual(["A:save", "B:cancel"]);
    controller.dispose();
  });

  test("does not publish committed or retry when commit fails", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const calls: string[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => {
        calls.push("capture");
        return createCaptureResult();
      },
      commitCapture: async () => {
        calls.push("commit");
        return { ok: false, code: "STALE_CAPTURE_OPERATION", error: "Capture operation belongs to a stale epoch." };
      },
      publishFailure: async (error) => {
        calls.push(`failure:${error}`);
      },
      publishCommitted: async () => {
        calls.push("committed");
      },
    });

    controller.setEnabled(true);
    button.click();
    await flushAsyncWork();

    expect(calls).toEqual([
      "capture",
      "commit",
      "failure:Capture operation belongs to a stale epoch.",
    ]);
    controller.dispose();
  });

  test("publishes one fixed safe failure when extraction throws", async () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const button = requireButton("#save");
    const failures: string[] = [];
    const controller = createTestClickCaptureController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async () => {
        throw new Error(`extract exploded ${SECRET}`);
      },
      commitCapture: async () => {
        throw new Error("should not commit");
      },
      publishFailure: async (error) => {
        failures.push(error);
      },
      publishCommitted: async () => {
        throw new Error("should not commit locally");
      },
    });

    controller.setEnabled(true);
    button.click();
    await flushAsyncWork();

    expect(failures).toEqual([SAFE_CAPTURE_ERROR]);
    expect(JSON.stringify(failures)).not.toContain(SECRET);
    controller.dispose();
  });
});

function createCaptureResult(): ContextCaptureResult {
  return {
    ok: true,
    json: "{}",
    record: {
      origin: "https://app.example.test",
      pageUrl: "https://app.example.test/settings",
      pageTitle: "Settings",
      attachment: {
        schemaVersion: "0.3.0",
        id: "att_save",
        capturedAt: "2026-07-11T10:00:00.000Z",
        source: { kind: "web", url: "https://app.example.test/settings", title: "Settings" },
        element: {
          tagName: "button",
          role: "button",
          text: "Save changes",
          accessibleName: "Save changes",
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          visible: true,
          enabled: true,
        },
        style: { display: "block", color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" },
        context: { parentSummary: null, nearbyText: [], selectorHints: [] },
        locatorBundle: { primary: null, candidates: [], stability: null },
        policy: {
          disclosureMode: "agent_safe",
          redactionLevel: "strict",
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
      },
      intent: "",
      markdown: "# Save changes",
      capturedAt: "2026-07-11T10:00:00.000Z",
    },
  };
}

function createReadback(): ActiveSessionReadback {
  return {
    origin: "https://app.example.test",
    epoch: "epoch-1",
    clearPending: false,
    activeClearOperationId: null,
    file: null,
    legacyRecord: null,
  };
}

function createReceipt() {
  return {
    origin: "https://app.example.test",
    epoch: "epoch-1",
    itemId: "att_save",
    label: "A",
  } as const;
}

function createSuccessfulCommit(itemId = "att_save", label = "A") {
  return {
    ok: true as const,
    data: {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId,
      label,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function requireButton(selector: string): HTMLButtonElement {
  const button = document.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`fixture ${selector} missing`);
  }
  return button;
}

function createPointerDown(
  options: { button?: number; isPrimary?: boolean; pointerType?: string } = {},
): MouseEvent {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    button: options.button ?? 0,
    cancelable: true,
  });
  Object.defineProperties(event, {
    isPrimary: { value: options.isPrimary ?? true },
    pointerType: { value: options.pointerType ?? "mouse" },
  });
  return event;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
