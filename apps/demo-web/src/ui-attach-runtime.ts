import {
  createUiAttachInjectedRuntime as createBaseUiAttachInjectedRuntime,
  type UiAttachInjectedRuntime,
  type UiAttachInjectedRuntimeOptions,
} from "@meanthis/web-picker";

export function createUiAttachInjectedRuntime(
  options: UiAttachInjectedRuntimeOptions,
): UiAttachInjectedRuntime {
  const root = options.root ?? document;
  const defaultSurface = root.querySelector("[data-ui-attach-surface]")
    ? "[data-ui-attach-surface]"
    : undefined;

  return createBaseUiAttachInjectedRuntime({
    ...options,
    surface: options.surface ?? defaultSurface,
    isSelectableTarget: (target) => {
      if (target.closest("[data-ui-attach-ignore]")) {
        return false;
      }

      return options.isSelectableTarget?.(target) ?? true;
    },
    labels: {
      placeholder: "Describe what the bookmarklet should capture",
      submit: "Export attachment",
      ...options.labels,
    },
  });
}
