import { describe, expect, test, vi } from "vitest";
import { UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT } from "./messages";
import {
  createSelectionLifecycleController,
  type SelectionLifecyclePort,
} from "./selection-lifecycle";

describe("selection lifecycle", () => {
  test("keeps an armed selection endpoint alive with bounded heartbeats", () => {
    const disconnectListeners: Array<() => void> = [];
    const port = {
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: {
        addListener: (listener: () => void) => disconnectListeners.push(listener),
      },
    } satisfies SelectionLifecyclePort;
    let heartbeat: (() => void) | null = null;
    const clearInterval = vi.fn();
    const controller = createSelectionLifecycleController({
      connect: () => port,
      onDisconnect: vi.fn(),
      setInterval: (callback) => {
        heartbeat = callback;
        return 17;
      },
      clearInterval,
    });

    expect(controller.arm()).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT,
    });
    expect(heartbeat).not.toBeNull();
    heartbeat?.();
    expect(port.postMessage).toHaveBeenCalledTimes(2);

    controller.disarm();
    expect(clearInterval).toHaveBeenCalledWith(17);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(controller.isArmed()).toBe(false);
  });

  test("clears its heartbeat and fails closed when the endpoint disconnects", () => {
    let disconnectListener: (() => void) | null = null;
    const port = {
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: {
        addListener: (listener: () => void) => {
          disconnectListener = listener;
        },
      },
    } satisfies SelectionLifecyclePort;
    const onDisconnect = vi.fn();
    const clearInterval = vi.fn();
    const controller = createSelectionLifecycleController({
      connect: () => port,
      onDisconnect,
      setInterval: () => 23,
      clearInterval,
    });

    expect(controller.arm()).toBe(true);
    disconnectListener?.();

    expect(clearInterval).toHaveBeenCalledWith(23);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(controller.isArmed()).toBe(false);
  });
});
