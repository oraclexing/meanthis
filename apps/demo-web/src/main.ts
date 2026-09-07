import { createMeanThisWebWidget } from "@meanthis/web-picker";

export function attachDemoSelection(root: Document): void {
  const searchParams = new URLSearchParams(root.location.search);
  const extensionTarget = searchParams.get("ui-attach-demo") === "extension-target";
  const debugInspectableDom = searchParams.get("ui-attach-inspect") === "1";
  const sdkWidgetStage = root.querySelector<HTMLElement>("#sdk-widget-demo-stage");
  const extensionGuide = root.querySelector<HTMLElement>("#extension-demo-guide");
  const sdkWidgetGuide = root.querySelector<HTMLElement>("#sdk-widget-demo-guide");

  if (root.body) {
    root.body.dataset.uiAttachDemoMode = extensionTarget ? "extension-target" : "sdk-widget";
    if (debugInspectableDom) root.body.dataset.uiAttachWidgetInspectable = "true";
    else delete root.body.dataset.uiAttachWidgetInspectable;
  }
  if (sdkWidgetStage) sdkWidgetStage.hidden = extensionTarget;
  if (extensionGuide) extensionGuide.hidden = !extensionTarget;
  if (sdkWidgetGuide) sdkWidgetGuide.hidden = extensionTarget;
  if (extensionTarget) return;

  const surface = root.querySelector<HTMLElement>("[data-ui-attach-surface]");
  const selectionSurface = root.querySelector<HTMLElement>("main") ?? surface;
  if (!surface || !selectionSurface) return;

  const widget = createMeanThisWebWidget({
    root,
    surface: selectionSurface,
    initialOpen: true,
    debugInspectableDom,
  });
  if (debugInspectableDom) {
    root.documentElement.dataset.meanthisWidgetWorkbench = "true";
  }

  root.defaultView?.addEventListener("pagehide", () => {
    widget.destroy();
    delete root.documentElement.dataset.meanthisWidgetWorkbench;
    delete root.body?.dataset.uiAttachWidgetInspectable;
  }, { once: true });
}

if (typeof document !== "undefined") {
  attachDemoSelection(document);
}
