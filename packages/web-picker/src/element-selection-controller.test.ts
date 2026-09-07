// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import {
  createElementSelectionAnchor,
  createElementSelectionController,
} from "./element-selection-controller";

describe("createElementSelectionController", () => {
  test("shares hover, continuous activation, and preview cleanup behavior", async () => {
    document.body.innerHTML = '<button id="first">First</button><button id="second">Second</button>';
    const first = requireButton("#first");
    const second = requireButton("#second");
    const previews: Array<HTMLElement | null> = [];
    const activations: HTMLElement[] = [];
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      previewTarget: (target) => previews.push(target),
      activateTarget: async (target) => { activations.push(target); },
      isTrustedActivationEvent: () => true,
    });

    first.dispatchEvent(pointer("pointermove"));
    expect(previews).toEqual([]);

    controller.setEnabled(true);
    first.dispatchEvent(pointer("pointermove"));
    second.dispatchEvent(pointer("pointermove"));
    second.dispatchEvent(pointer("pointermove"));
    first.click();
    second.click();
    await flushAsyncWork();

    expect(previews).toEqual([first, second, first, second, null]);
    expect(activations).toEqual([first, second]);
    expect(controller.isEnabled()).toBe(true);

    controller.setEnabled(false);
    expect(previews.at(-1)).toBeNull();
    controller.dispose();
  });

  test("turns one pointer gesture into one activation and suppresses its following click", async () => {
    document.body.innerHTML = '<button id="target">Target</button>';
    const target = requireButton("#target");
    const activateTarget = vi.fn(async () => undefined);
    const pageAction = vi.fn();
    target.addEventListener("click", pageAction);
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      activateTarget,
      isTrustedActivationEvent: () => true,
    });
    controller.setEnabled(true);

    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 40,
      left: 20,
      top: 40,
      right: 220,
      bottom: 140,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);
    const pointerDown = pointer("pointerdown", { button: 0, clientX: 70, clientY: 115 });
    const click = pointer("click", { button: 0 });
    target.dispatchEvent(pointerDown);
    target.dispatchEvent(click);
    await flushAsyncWork();

    expect(activateTarget).toHaveBeenCalledOnce();
    expect(activateTarget).toHaveBeenCalledWith(
      target,
      { xRatio: 0.25, yRatio: 0.75 },
      { kind: "element_relative_pointer", xRatio: 0.25, yRatio: 0.75 },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(pageAction).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("keeps the accepted target previewed until its async activation settles", async () => {
    document.body.innerHTML = '<button id="target">Target</button>';
    const target = requireButton("#target");
    const releaseActivation = deferred<void>();
    const previews: Array<HTMLElement | null> = [];
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      previewTarget: (next) => previews.push(next),
      activateTarget: async () => {
        expect(previews.at(-1)).toBe(target);
        await releaseActivation.promise;
        expect(previews.at(-1)).toBe(target);
      },
      isTrustedActivationEvent: () => true,
    });
    controller.setEnabled(true);

    target.dispatchEvent(pointer("pointerdown", { button: 0 }));
    expect(previews).toEqual([target]);

    releaseActivation.resolve();
    await flushAsyncWork();
    expect(previews).toEqual([target, null]);
    controller.dispose();
  });

  test("clears the accepted preview after an async activation rejects", async () => {
      document.body.innerHTML = '<button id="target">Target</button>';
      const target = requireButton("#target");
      const releaseActivation = deferred<void>();
      const previews: Array<HTMLElement | null> = [];
      const reportFailure = vi.fn(async () => undefined);
      const controller = createElementSelectionController({
        root: document,
        resolveTarget: selectableButton,
        previewTarget: (next) => previews.push(next),
        activateTarget: async () => {
          await releaseActivation.promise;
          throw new Error("commit rejected");
        },
        reportFailure,
        isTrustedActivationEvent: () => true,
      });
      controller.setEnabled(true);

      target.dispatchEvent(pointer("pointerdown", { button: 0 }));
      expect(previews).toEqual([target]);
      releaseActivation.resolve();
      await flushAsyncWork();

      expect(previews).toEqual([target, null]);
      expect(reportFailure).toHaveBeenCalledOnce();
      controller.dispose();
  });

  test("does not let an older activation clear a newer hover or selection generation", async () => {
    document.body.innerHTML = '<button id="first">First</button><button id="second">Second</button>';
    const first = requireButton("#first");
    const second = requireButton("#second");
    const firstRelease = deferred<void>();
    const sameTargetFirstRelease = deferred<void>();
    const sameTargetSecondRelease = deferred<void>();
    const previews: Array<HTMLElement | null> = [];
    let activationCount = 0;
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      previewTarget: (next) => previews.push(next),
      activateTarget: async (target) => {
        activationCount += 1;
        if (activationCount === 1) {
          expect(target).toBe(first);
          await firstRelease.promise;
        } else {
          expect(target).toBe(second);
          if (activationCount === 2) await sameTargetFirstRelease.promise;
          else await sameTargetSecondRelease.promise;
        }
      },
      isTrustedActivationEvent: () => true,
    });
    controller.setEnabled(true);

    first.dispatchEvent(pointer("pointerdown", { button: 0 }));
    second.dispatchEvent(pointer("pointermove"));
    firstRelease.resolve();
    await flushAsyncWork();
    expect(previews).toEqual([first, second]);

    second.dispatchEvent(pointer("pointerdown", { button: 0 }));
    second.dispatchEvent(pointer("pointerdown", { button: 0 }));
    sameTargetFirstRelease.resolve();
    await flushAsyncWork();
    expect(previews.at(-1)).toBe(second);
    sameTargetSecondRelease.resolve();
    await flushAsyncWork();
    expect(previews.at(-1)).toBeNull();
    controller.dispose();
  });

  test.each(["requestDisable", "setEnabled", "dispose"] as const)(
    "keeps %s cleanup authoritative over a pending activation",
    async (cleanup) => {
      document.body.innerHTML = '<button id="target">Target</button>';
      const target = requireButton("#target");
      const releaseActivation = deferred<void>();
      const releaseDisable = deferred<void>();
      const previews: Array<HTMLElement | null> = [];
      const controller = createElementSelectionController({
        root: document,
        resolveTarget: selectableButton,
        previewTarget: (next) => previews.push(next),
        activateTarget: async () => { await releaseActivation.promise; },
        requestDisable: async () => { await releaseDisable.promise; },
        isTrustedActivationEvent: () => true,
      });
      controller.setEnabled(true);
      target.dispatchEvent(pointer("pointerdown", { button: 0 }));

      if (cleanup === "requestDisable") controller.requestDisable();
      else if (cleanup === "setEnabled") controller.setEnabled(false);
      else controller.dispose();
      expect(previews).toEqual([target, null]);

      releaseActivation.resolve();
      await flushAsyncWork();
      expect(previews).toEqual([target, null]);
      releaseDisable.resolve();
      await flushAsyncWork();
      expect(previews.at(-1)).toBeNull();
      expect(previews.slice(1)).not.toContain(target);
      if (cleanup !== "dispose") controller.dispose();
    },
  );

  test.each(["requestDisable", "setEnabled", "disableForNavigation", "dispose"] as const)(
    "does not start queued serialized activations after %s",
    async (cleanup) => {
      document.body.innerHTML = '<button id="first">First</button><button id="second">Second</button>';
      const first = requireButton("#first");
      const second = requireButton("#second");
      const releaseFirst = deferred<void>();
      const started: string[] = [];
      const previews: Array<HTMLElement | null> = [];
      const controller = createElementSelectionController({
        root: document,
        resolveTarget: selectableButton,
        previewTarget: (next) => previews.push(next),
        activateTarget: async (target) => {
          started.push(target.id);
          if (target === first) await releaseFirst.promise;
        },
        requestDisable: async () => undefined,
        serializeActivations: true,
        isTrustedActivationEvent: () => true,
      });
      controller.setEnabled(true);

      first.click();
      second.click();
      await Promise.resolve();
      expect(started).toEqual(["first"]);

      if (cleanup === "requestDisable") controller.requestDisable();
      else if (cleanup === "setEnabled") controller.setEnabled(false);
      else if (cleanup === "disableForNavigation") controller.disableForNavigation();
      else controller.dispose();
      releaseFirst.resolve();
      await flushAsyncWork();

      expect(started).toEqual(["first"]);
      expect(previews.at(-1)).toBeNull();
      if (cleanup !== "dispose") controller.dispose();
    },
  );

  test("does not report a stale activation failure after navigation invalidates it", async () => {
    document.body.innerHTML = '<button id="target">Target</button>';
    const releaseActivation = deferred<void>();
    const reportFailure = vi.fn(async () => undefined);
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      activateTarget: async () => {
        await releaseActivation.promise;
        throw new Error("old route failed");
      },
      reportFailure,
      requestDisable: async () => undefined,
      isTrustedActivationEvent: () => true,
    });
    controller.setEnabled(true);
    requireButton("#target").click();

    controller.disableForNavigation();
    releaseActivation.resolve();
    await flushAsyncWork();

    expect(reportFailure).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("serializes accepted activations", async () => {
    document.body.innerHTML = '<button id="first">First</button><button id="second">Second</button>';
    const first = requireButton("#first");
    const second = requireButton("#second");
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      isTrustedActivationEvent: () => true,
      serializeActivations: true,
      activateTarget: async (target) => {
        order.push(`start:${target.id}`);
        if (target === first) await releaseFirst.promise;
        order.push(`end:${target.id}`);
      },
    });
    controller.setEnabled(true);

    first.click();
    second.click();
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);
    releaseFirst.resolve();
    await flushAsyncWork();

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    controller.dispose();
  });

  test("uses Escape and navigation to disable locally while delegating persistence", async () => {
    const requestDisable = vi.fn(async () => undefined);
    const enabledChanges: boolean[] = [];
    const pageShortcut = vi.fn();
    document.addEventListener("keydown", pageShortcut);
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      activateTarget: async () => undefined,
      requestDisable,
      onEnabledChange: (enabled) => enabledChanges.push(enabled),
      isTrustedKeyEvent: () => true,
    });
    controller.setEnabled(true);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    await flushAsyncWork();

    expect(escape.defaultPrevented).toBe(true);
    expect(pageShortcut).not.toHaveBeenCalled();
    expect(requestDisable).toHaveBeenCalledOnce();
    expect(controller.isEnabled()).toBe(false);

    controller.setEnabled(true);
    controller.disableForNavigation();
    expect(controller.isEnabled()).toBe(false);
    await flushAsyncWork();
    expect(requestDisable).toHaveBeenCalledTimes(2);
    expect(enabledChanges).toEqual([true, false, true, false]);
    document.removeEventListener("keydown", pageShortcut);
    controller.dispose();
  });

  test("computes one shared clamped anchor contract", () => {
    const target = document.createElement("button");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 40,
      left: 20,
      top: 40,
      right: 220,
      bottom: 140,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);

    expect(createElementSelectionAnchor(target, new MouseEvent("click", {
      clientX: 70,
      clientY: 115,
      detail: 1,
    }))).toEqual({ xRatio: 0.25, yRatio: 0.75 });
    expect(createElementSelectionAnchor(target, new MouseEvent("click", {
      clientX: -500,
      clientY: 900,
      detail: 1,
    }))).toEqual({ xRatio: 0, yRatio: 1 });
    expect(createElementSelectionAnchor(target, new MouseEvent("click")))
      .toEqual({ xRatio: 0.5, yRatio: 0.5 });
  });

  test("does not invent a pointer position for a keyboard-style activation", async () => {
    document.body.innerHTML = '<button id="target">Target</button>';
    const target = requireButton("#target");
    const activateTarget = vi.fn(async () => undefined);
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      activateTarget,
      isTrustedActivationEvent: () => true,
    });
    controller.setEnabled(true);

    target.click();
    await flushAsyncWork();

    expect(activateTarget).toHaveBeenCalledWith(
      target,
      { xRatio: 0.5, yRatio: 0.5 },
      null,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    controller.dispose();
  });

  test("fails open to retry when persisted disable fails but navigation remains locally disabled", async () => {
    const reportFailure = vi.fn(async () => undefined);
    const requestDisable = vi.fn(async () => { throw new Error("worker restarted"); });
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      activateTarget: async () => undefined,
      requestDisable,
      reportFailure,
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
    expect(reportFailure).toHaveBeenCalledOnce();

    controller.disableForNavigation();
    expect(controller.isEnabled()).toBe(false);
    await flushAsyncWork();
    expect(reportFailure).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test("ignores untrusted, secondary, touch, and unresolved events", async () => {
    document.body.innerHTML = '<button id="target">Target</button><div id="blank"></div>';
    const target = requireButton("#target");
    const activateTarget = vi.fn(async () => undefined);
    let trusted = false;
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      activateTarget,
      isTrustedActivationEvent: () => trusted,
    });
    controller.setEnabled(true);

    target.click();
    trusted = true;
    target.dispatchEvent(pointer("pointerdown", { button: 1 }));
    target.dispatchEvent(pointer("pointerdown", { button: 0, pointerType: "touch" }));
    document.querySelector("#blank")?.dispatchEvent(pointer("click"));
    await flushAsyncWork();

    expect(activateTarget).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("seeds only connected targets and disposes every listener", async () => {
    document.body.innerHTML = '<button id="target">Target</button>';
    const target = requireButton("#target");
    const previews: Array<HTMLElement | null> = [];
    const activateTarget = vi.fn(async () => undefined);
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      previewTarget: (next) => previews.push(next),
      activateTarget,
      isTrustedActivationEvent: () => true,
    });

    expect(controller.seedPreview(target)).toBe(false);
    controller.setEnabled(true);
    expect(controller.seedPreview(target)).toBe(true);
    expect(controller.seedPreview(document.createElement("button"))).toBe(false);
    controller.dispose();
    target.click();
    await flushAsyncWork();

    expect(previews).toEqual([target, null]);
    expect(activateTarget).not.toHaveBeenCalled();
  });

  test("leaves adapter-owned pointer, click, move, and Escape events outside selection", async () => {
    document.body.innerHTML = '<button id="owned">Owned</button>';
    const owned = requireButton("#owned");
    const previews: Array<HTMLElement | null> = [];
    const activateTarget = vi.fn(async () => undefined);
    const requestDisable = vi.fn(async () => undefined);
    const controller = createElementSelectionController({
      root: document,
      resolveTarget: selectableButton,
      previewTarget: (target) => previews.push(target),
      activateTarget,
      requestDisable,
      isTrustedActivationEvent: () => true,
      isTrustedKeyEvent: () => true,
      isOwnedUiEvent: (event) => event.composedPath().includes(owned),
    });
    controller.setEnabled(true);

    owned.dispatchEvent(pointer("pointermove"));
    owned.dispatchEvent(pointer("pointerdown", { button: 0 }));
    owned.click();
    owned.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    await flushAsyncWork();

    expect(previews).toEqual([]);
    expect(activateTarget).not.toHaveBeenCalled();
    expect(requestDisable).not.toHaveBeenCalled();
    expect(controller.isEnabled()).toBe(true);
    controller.dispose();
  });
});

function selectableButton(event: MouseEvent): HTMLElement | null {
  return event.composedPath().find((candidate): candidate is HTMLElement =>
    candidate instanceof HTMLElement && candidate.tagName === "BUTTON",
  ) ?? null;
}

function requireButton(selector: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing ${selector}`);
  return button;
}

function pointer(type: string, init: MouseEventInit & { pointerType?: string } = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  if (init.pointerType) Object.defineProperty(event, "pointerType", { value: init.pointerType });
  return event;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
