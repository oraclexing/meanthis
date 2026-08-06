import "./panel.css";
import { createBrowserLocalAgentBridgeProxy } from "./local-agent-bridge-runtime";
import { createBrowserPanelDependencies, initializePanel } from "./panel";
import type { ExtensionSurfaceProfile } from "./surface-profile";

export function initializeSurfacePanel(surfaceProfile: ExtensionSurfaceProfile): Promise<void> {
  return initializePanel(createBrowserPanelDependencies({
    localBridge: createBrowserLocalAgentBridgeProxy(),
    surfaceProfile,
  }));
}
