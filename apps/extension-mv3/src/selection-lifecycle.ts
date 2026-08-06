export interface SelectionLifecyclePort {
  disconnect(): void;
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
}): SelectionLifecycleController {
  let port: SelectionLifecyclePort | null = null;

  function arm(): boolean {
    if (port) return true;
    try {
      const nextPort = options.connect();
      port = nextPort;
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return;
        port = null;
        options.onDisconnect();
      });
      return true;
    } catch {
      options.onDisconnect();
      return false;
    }
  }

  function disarm(): void {
    const current = port;
    port = null;
    current?.disconnect();
  }

  return {
    arm,
    disarm,
    isArmed: () => port !== null,
  };
}
