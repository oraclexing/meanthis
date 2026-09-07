import { UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT } from "./messages";

export interface SelectionLifecyclePort {
  disconnect(): void;
  postMessage(message: unknown): void;
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

export interface SelectionLifecycleController {
  arm(): boolean;
  disarm(): void;
  isArmed(): boolean;
}

export function createSelectionLifecycleController(options: {
  connect(): SelectionLifecyclePort;
  onDisconnect(): void;
  setInterval?(callback: () => void, delay: number): number;
  clearInterval?(handle: number): void;
  heartbeatIntervalMs?: number;
}): SelectionLifecycleController {
  let port: SelectionLifecyclePort | null = null;
  let heartbeatHandle: number | null = null;
  const scheduleInterval = options.setInterval
    ?? ((callback: () => void, delay: number) => globalThis.setInterval(callback, delay));
  const cancelInterval = options.clearInterval
    ?? ((handle: number) => globalThis.clearInterval(handle));

  function clearHeartbeat(): void {
    if (heartbeatHandle === null) return;
    cancelInterval(heartbeatHandle);
    heartbeatHandle = null;
  }

  function failClosed(current: SelectionLifecyclePort): void {
    if (port !== current) return;
    port = null;
    clearHeartbeat();
    try {
      current.disconnect();
    } catch {
      // The endpoint is already unavailable.
    }
    options.onDisconnect();
  }

  function postHeartbeat(current: SelectionLifecyclePort): void {
    try {
      current.postMessage({ type: UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT });
    } catch {
      failClosed(current);
    }
  }

  function arm(): boolean {
    if (port) return true;
    try {
      const nextPort = options.connect();
      port = nextPort;
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return;
        port = null;
        clearHeartbeat();
        options.onDisconnect();
      });
      postHeartbeat(nextPort);
      if (port !== nextPort) return false;
      heartbeatHandle = scheduleInterval(
        () => postHeartbeat(nextPort),
        options.heartbeatIntervalMs ?? 20_000,
      );
      return port === nextPort;
    } catch {
      port = null;
      clearHeartbeat();
      options.onDisconnect();
      return false;
    }
  }

  function disarm(): void {
    const current = port;
    port = null;
    clearHeartbeat();
    try {
      current?.disconnect();
    } catch {
      // Disarming is already complete locally.
    }
  }

  return {
    arm,
    disarm,
    isArmed: () => port !== null,
  };
}
