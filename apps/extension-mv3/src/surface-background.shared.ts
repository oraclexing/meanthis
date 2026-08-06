import type { BackgroundRuntimeFeature } from "./background-controller";
import {
  LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN,
  createBrowserLocalAgentBridgeClient,
} from "./local-agent-bridge";
import { createLocalAgentBridgeBackgroundController } from "./local-agent-bridge-background";
import { createLocalAgentBridgeRuntimeFeature } from "./local-agent-bridge-runtime";

const localAgentBridge = createBrowserLocalAgentBridgeClient({
  requestPermission: async () => true,
  withSessionLock: (operation) => operation(),
});

const localAgentBridgeBackground = createLocalAgentBridgeBackgroundController({
  bridge: localAgentBridge,
  alarms: chrome.alarms,
  removePermission: () => chrome.permissions.remove({
    origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN],
  }),
  storage: chrome.storage,
});

export const backgroundRuntimeFeatures: readonly BackgroundRuntimeFeature[] = [
  createLocalAgentBridgeRuntimeFeature(localAgentBridge),
];

export function registerSurfaceBackground(): void {
  localAgentBridgeBackground.register();
}
