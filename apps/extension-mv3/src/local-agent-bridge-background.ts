import {
  LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY,
  type LocalAgentBridgeClient,
  type LocalAgentBridgeStatus,
} from "./local-agent-bridge";

export const LOCAL_AGENT_BRIDGE_REFRESH_ALARM = "ui-attach.local-agent-bridge.refresh.v1";
const LOCAL_AGENT_BRIDGE_REFRESH_DELAY_MINUTES = 0.5;

interface LocalAgentBridgeAlarm {
  name: string;
}

interface LocalAgentBridgeBackgroundDependencies {
  bridge: LocalAgentBridgeClient;
  removePermission(): Promise<boolean>;
  alarms: {
    create(name: string, alarmInfo: { delayInMinutes: number }): void;
    clear(name: string): Promise<boolean>;
    onAlarm: {
      addListener(listener: (alarm: LocalAgentBridgeAlarm) => void): void;
    };
  };
  storage: {
    onChanged: {
      addListener(listener: (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ) => void): void;
    };
  };
}

export interface LocalAgentBridgeBackgroundController {
  initialize(): Promise<void>;
  handleAlarm(alarm: LocalAgentBridgeAlarm): Promise<void>;
  handleSessionStorageChanged(
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    areaName: string,
  ): Promise<void>;
  register(): void;
}

export function createLocalAgentBridgeBackgroundController(
  dependencies: LocalAgentBridgeBackgroundDependencies,
): LocalAgentBridgeBackgroundController {
  let operationTail: Promise<void> = Promise.resolve();

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => undefined);
    return result;
  }

  async function scheduleFromStatus(status: LocalAgentBridgeStatus): Promise<void> {
    if (status.pending || status.connected) {
      dependencies.alarms.create(LOCAL_AGENT_BRIDGE_REFRESH_ALARM, {
        delayInMinutes: LOCAL_AGENT_BRIDGE_REFRESH_DELAY_MINUTES,
      });
      return;
    }
    await closeIdleState();
  }

  async function closeIdleState(): Promise<void> {
    await dependencies.alarms.clear(LOCAL_AGENT_BRIDGE_REFRESH_ALARM).catch(() => false);
    await dependencies.removePermission().catch(() => false);
  }

  return {
    initialize() {
      return enqueue(async () => {
        try {
          await scheduleFromStatus(await dependencies.bridge.readStatus());
        } catch {
          await closeIdleState();
        }
      });
    },

    handleAlarm(alarm) {
      if (alarm.name !== LOCAL_AGENT_BRIDGE_REFRESH_ALARM) return Promise.resolve();
      return enqueue(async () => {
        try {
          await scheduleFromStatus(await dependencies.bridge.refreshConnectionAndPublish());
        } catch {
          await closeIdleState();
        }
      });
    },

    handleSessionStorageChanged(changes, areaName) {
      if (
        areaName !== "session" ||
        !(LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY in changes)
      ) {
        return Promise.resolve();
      }
      return enqueue(async () => {
        try {
          await scheduleFromStatus(await dependencies.bridge.readStatus());
        } catch {
          await closeIdleState();
        }
      });
    },

    register() {
      dependencies.alarms.onAlarm.addListener((alarm) => {
        void this.handleAlarm(alarm);
      });
      dependencies.storage.onChanged.addListener((changes, areaName) => {
        void this.handleSessionStorageChanged(changes, areaName);
      });
      void this.initialize();
    },
  };
}
