// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OverlayRestoreData } from "./messages";
import { createOverlayRebindController } from "./overlay-rebind";
import type { DomReplayTargetResult } from "./replay-dom";

const ORIGIN = "https://app.example.test";

describe("createOverlayRebindController", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  test("binds restored targets and follows same-route DOM replacements", async () => {
    const original = createVisibleButton();
    const bindTarget = vi.fn();
    const controller = createOverlayRebindController({ root: document, bindTarget });

    await controller.restore(createRestoreData());
    expect(bindTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: "att_save", label: "A" }),
      original,
    );

    const replacement = createVisibleButton();
    original.replaceWith(replacement);
    await waitFor(() => bindTarget.mock.calls.some((call) => call[1] === replacement));

    expect(bindTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: "att_save", label: "A" }),
      replacement,
    );
    controller.dispose();
  });

  test("retains a fresh dynamic target across same-route restore refreshes", async () => {
    const target = createVisibleButton();
    const bindTarget = vi.fn();
    const resolveTarget = vi.fn(async (): Promise<DomReplayTargetResult> => ({
      status: "missing",
      target: null,
    }));
    const controller = createOverlayRebindController({ root: document, bindTarget, resolveTarget });

    await controller.commitCurrent(createRestoreData().items[0], target);
    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "restored" }]);
    expect(resolveTarget).not.toHaveBeenCalled();
    target.textContent = "Likes 11";
    await flushMutationWork();
    await controller.restore(createRestoreData());
    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "restored" }]);
    expect(resolveTarget).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("keeps five sequential live captures independent of stored replay count", async () => {
    const targets = Array.from({ length: 5 }, () => createVisibleButton());
    const resolveTarget = vi.fn(async (): Promise<DomReplayTargetResult> => ({
      status: "missing",
      target: null,
    }));
    const controller = createOverlayRebindController({
      root: document,
      bindTarget: vi.fn(),
      resolveTarget,
    });

    for (const [index, target] of targets.entries()) {
      const ordinal = index + 1;
      await controller.commitCurrent({
        itemId: `att_${ordinal}`,
        attachmentId: `att_${ordinal}`,
        label: String.fromCharCode(64 + ordinal),
        locators: [{
          strategy: "playwright.testId",
          value: `page.getByTestId(\"target-${ordinal}\")`,
          confidence: 0.9,
        }],
      }, target);
    }

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(readStatuses(controller)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        itemId: `att_${index + 1}`,
        status: "restored",
      })),
    );
    controller.dispose();
  });

  test("keeps connected live targets bound while their descendant text changes", async () => {
    const targets = Array.from({ length: 5 }, (_, index) => {
      const target = createVisibleButton();
      target.dataset.testid = `target-${index + 1}`;
      return target;
    });
    const data: OverlayRestoreData = {
      origin: ORIGIN,
      activeItemId: "att_5",
      items: targets.map((_target, index) => ({
        itemId: `att_${index + 1}`,
        attachmentId: `att_${index + 1}`,
        label: String.fromCharCode(65 + index),
        locators: [{
          strategy: "playwright.testId",
          value: `page.getByTestId(\"target-${index + 1}\")`,
          confidence: 0.9,
        }],
      })),
    };
    const resolveTarget = vi.fn(async (
      _root: Document,
      locators: OverlayRestoreData["items"][number]["locators"],
    ): Promise<DomReplayTargetResult> => {
      const match = /target-(\d+)/u.exec(locators[0]?.value ?? "");
      const target = match ? targets[Number(match[1]) - 1] : undefined;
      return target ? { status: "restored", target } : { status: "missing", target: null };
    });
    const unbindTarget = vi.fn();
    const controller = createOverlayRebindController({
      root: document,
      bindTarget: vi.fn(),
      unbindTarget,
      resolveTarget,
    });
    await controller.restore(data);
    resolveTarget.mockClear();

    document.body.append(document.createElement("div"));
    await flushMutationWork();
    expect(resolveTarget).not.toHaveBeenCalled();

    const clock = document.createElement("span");
    const clockText = document.createTextNode("10:00:00");
    clock.append(clockText);
    targets[2].append(clock);
    await flushMutationWork();
    clockText.data = "10:00:01";
    await flushMutationWork();
    clock.replaceChildren("10:00:02");
    await flushMutationWork();
    targets[2].classList.add("liked");
    await flushMutationWork();

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(unbindTarget).not.toHaveBeenCalled();
    expect(readStatuses(controller)[2]).toEqual({ itemId: "att_3", status: "restored" });
    controller.dispose();
  });

  test("updates connected target visibility without replaying its stale descriptor", async () => {
    const target = createVisibleButton();
    const resolveTarget = vi.fn(async (): Promise<DomReplayTargetResult> => ({
      status: "missing",
      target: null,
    }));
    const bindTarget = vi.fn();
    const unbindTarget = vi.fn();
    const controller = createOverlayRebindController({
      root: document,
      bindTarget,
      unbindTarget,
      resolveTarget,
    });

    await controller.commitCurrent(createRestoreData().items[0], target);
    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "restored" }]);
    target.hidden = true;
    await waitFor(() => readStatuses(controller)[0]?.status === "missing");
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(unbindTarget).toHaveBeenLastCalledWith("att_save");

    target.hidden = false;
    await waitFor(() => readStatuses(controller)[0]?.status === "restored");
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(bindTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: "att_save" }),
      target,
    );
    controller.dispose();
  });

  test("revalidates a connected fresh target after it becomes hidden", async () => {
    const target = createVisibleButton();
    const controller = createOverlayRebindController({ root: document, bindTarget: vi.fn() });

    await controller.commitCurrent(createRestoreData().items[0], target);
    await waitFor(() => readStatuses(controller)[0]?.status === "restored");
    target.hidden = true;

    await waitFor(() => readStatuses(controller)[0]?.status === "missing");
    expect(target.isConnected).toBe(true);
    controller.dispose();
  });

  test("drops removed descriptors so later mutations cannot resurrect an overlay", async () => {
    const original = createVisibleButton();
    const bindTarget = vi.fn();
    const controller = createOverlayRebindController({ root: document, bindTarget });
    await controller.restore(createRestoreData());
    expect(bindTarget).toHaveBeenCalledTimes(1);

    controller.applyState({
      type: "ui-attach:overlay-state",
      origin: ORIGIN,
      activeItemId: null,
      items: [],
    });
    const replacement = createVisibleButton();
    original.replaceWith(replacement);
    await flushMutationWork();

    expect(bindTarget).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test("reports missing and ambiguous targets without retaining an old binding", async () => {
    const bindTarget = vi.fn();
    const unbindTarget = vi.fn();
    const controller = createOverlayRebindController({
      root: document,
      bindTarget,
      ...{ unbindTarget },
    });

    await controller.restore(createRestoreData());
    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "missing" }]);
    expect(unbindTarget).toHaveBeenLastCalledWith("att_save");

    const first = createVisibleButton();
    const second = createVisibleButton();
    await waitFor(() => readStatuses(controller)[0]?.status === "ambiguous");

    expect(bindTarget).not.toHaveBeenCalled();
    expect(unbindTarget).toHaveBeenLastCalledWith("att_save");
    first.remove();
    second.remove();
    controller.dispose();
  });

  test("moves current status from missing to restored after a same-route replacement appears", async () => {
    const bindTarget = vi.fn();
    const controller = createOverlayRebindController({ root: document, bindTarget });
    await controller.restore(createRestoreData());
    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "missing" }]);

    const replacement = createVisibleButton();
    await waitFor(() => readStatuses(controller)[0]?.status === "restored");

    expect(bindTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: "att_save" }),
      replacement,
    );
    controller.dispose();
  });

  test("serializes mutation rebinds so an older result cannot overwrite newer DOM truth", async () => {
    const target = createVisibleButton();
    const pending: Array<(result: DomReplayTargetResult) => void> = [];
    const resolveTarget = vi.fn(() => new Promise<DomReplayTargetResult>(
      (resolve) => pending.push(resolve),
    ));
    const events: string[] = [];
    const controller = createOverlayRebindController({
      root: document,
      resolveTarget,
      bindTarget: (_item, resolvedTarget) => events.push(
        resolvedTarget === target ? "restored" : "unexpected-target",
      ),
      unbindTarget: () => events.push("missing"),
    });

    const restore = controller.restore(createRestoreData());
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    document.body.append(document.createElement("div"));
    await flushMutationWork();
    expect(resolveTarget).toHaveBeenCalledTimes(1);

    pending.shift()?.({ status: "missing", target: null });
    await waitFor(() => resolveTarget.mock.calls.length === 2);
    pending.shift()?.({ status: "restored", target });
    await restore;

    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "restored" }]);
    expect(events).toEqual(["missing", "restored"]);
    controller.dispose();
  });

  test("does not lose a restore requested while the previous rebind is settling", async () => {
    const target = createVisibleButton();
    const pending: Array<(result: DomReplayTargetResult) => void> = [];
    const resolveTarget = vi.fn(() => new Promise<DomReplayTargetResult>(
      (resolve) => pending.push(resolve),
    ));
    const controller = createOverlayRebindController({
      root: document,
      bindTarget: vi.fn(),
      resolveTarget,
    });

    const firstRestore = controller.restore(createRestoreData());
    pending.shift()?.({ status: "restored", target });
    const secondRestore = controller.restore(createRestoreData());
    await waitFor(() => resolveTarget.mock.calls.length === 2);
    pending.shift()?.({ status: "restored", target });
    await Promise.all([firstRestore, secondRestore]);

    expect(readStatuses(controller)).toEqual([{ itemId: "att_save", status: "restored" }]);
    controller.dispose();
  });

  test.each(["pushState", "replaceState"] as const)(
    "clears descriptors after a pure history.%s pathname change",
    async (method) => {
    const original = createVisibleButton();
    const bindTarget = vi.fn();
    const onRouteChange = vi.fn();
    const controller = createOverlayRebindController({
      root: document,
      bindTarget,
      onRouteChange,
      routePollIntervalMs: 1,
    });
    await controller.restore(createRestoreData());
    expect(bindTarget).toHaveBeenCalledTimes(1);

    window.history[method]({}, "", "/another-page?view=compact#top");
    await waitFor(() => onRouteChange.mock.calls.length === 1);
    await flushMutationWork();

    expect(bindTarget).toHaveBeenCalledTimes(1);
    expect(original.isConnected).toBe(true);
    controller.dispose();
    },
  );

  test("reports a route change after tracking a live target without replay descriptors", async () => {
    const onRouteChange = vi.fn();
    const controller = createOverlayRebindController({
      root: document,
      bindTarget: vi.fn(),
      onRouteChange,
      routePollIntervalMs: 1,
    });

    controller.trackCurrentRoute();
    window.history.pushState({}, "", "/profile");
    await waitFor(() => onRouteChange.mock.calls.length === 1);

    expect(controller.readStatus()).toEqual([]);
    controller.dispose();
  });
});

function createRestoreData(): OverlayRestoreData {
  return {
    origin: ORIGIN,
    activeItemId: "att_save",
    items: [{
      itemId: "att_save",
      attachmentId: "att_save",
      label: "A",
      locators: [{
        strategy: "playwright.testId",
        value: 'page.getByTestId("save")',
        confidence: 0.9,
      }],
    }],
  };
}

function createVisibleButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.dataset.testid = "save";
  button.textContent = "Save";
  button.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    top: 0,
    left: 0,
    right: 100,
    bottom: 30,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.append(button);
  return button;
}

async function flushMutationWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMutationWork();
  }
  throw new Error("condition was not reached");
}

function readStatuses(
  controller: ReturnType<typeof createOverlayRebindController>,
): Array<{ itemId: string; status: string }> {
  return (controller as typeof controller & {
    readStatus(): Array<{ itemId: string; status: string }>;
  }).readStatus();
}
