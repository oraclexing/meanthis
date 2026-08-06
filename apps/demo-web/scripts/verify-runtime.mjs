const runtimeModule = await import("../dist/ui-attach-runtime.js");

if (typeof runtimeModule.createUiAttachInjectedRuntime !== "function") {
  throw new Error("dist/ui-attach-runtime.js must export createUiAttachInjectedRuntime");
}
