import type { ExtensionStorageArea } from "./capture-store";

export function createDevelopmentAwareLocalAgentBridgeBootstrap(options: {
  nativeBootstrap(): Promise<void>;
  storage: ExtensionStorageArea;
}): () => Promise<void> {
  return options.nativeBootstrap;
}

export function registerDevelopmentRuntimeControl(): void {}

export function createDevelopmentCaptureCommitGate(_options: {
  storage: ExtensionStorageArea;
}) {
  return {
    beforeWrite: async (_operationId: string) => undefined,
    afterWrite: async (_operationId: string) => undefined,
  };
}

export function createDevelopmentAnnotationLifecycleExecutionGate(_options: {
  storage: ExtensionStorageArea;
}) {
  return {
    afterApproved: async (_operationId: string) => undefined,
    afterCanonicalCommit: async (_operationId: string) => undefined,
    afterCommitted: async (_operationId: string) => undefined,
  };
}
