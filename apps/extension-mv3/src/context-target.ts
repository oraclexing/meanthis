export interface ContextTargetTracker {
  dispose: () => void;
  getLatestTarget: () => HTMLElement | null;
  takeLatestTarget: () => HTMLElement | null;
}

export function createContextTargetTracker(root: Document): ContextTargetTracker {
  let latestTarget: HTMLElement | null = null;

  const handleContextMenu = (event: MouseEvent): void => {
    latestTarget = getSelectableComposedTarget(root, event);
  };

  root.addEventListener("contextmenu", handleContextMenu, { capture: true });

  return {
    dispose: () => {
      root.removeEventListener("contextmenu", handleContextMenu, { capture: true });
      latestTarget = null;
    },
    getLatestTarget: () => latestTarget,
    takeLatestTarget: () => {
      const target = latestTarget;
      latestTarget = null;
      return target;
    },
  };
}

export function getSelectableComposedTarget(
  root: Document,
  event: MouseEvent,
): HTMLElement | null {
  const composedElements = event
    .composedPath()
    .filter((target): target is HTMLElement => isHTMLElement(root, target));
  if (composedElements.some((element) => element.matches("[data-ui-attach-ignore]"))) {
    return null;
  }
  const activationTarget = composedElements.find((element) =>
    element.matches('button, a[href]'),
  );
  return getSelectableTarget(root, activationTarget ?? composedElements[0] ?? event.target);
}

export function getSelectableTarget(root: Document, target: EventTarget | null): HTMLElement | null {
  if (!isElement(root, target)) {
    return null;
  }

  if (target === root.body || target === root.documentElement) {
    return null;
  }

  if (target.closest("[data-ui-attach-ignore]")) {
    return null;
  }

  const activationTarget = target.closest('button, a[href]');
  if (isHTMLElement(root, activationTarget)) {
    return activationTarget;
  }

  return isHTMLElement(root, target) ? target : null;
}

function isElement(root: Document, target: EventTarget | null): target is Element {
  const ElementConstructor = root.defaultView?.Element;
  if (ElementConstructor) {
    return target instanceof ElementConstructor;
  }
  if (!target || typeof target !== "object") {
    return false;
  }
  const candidate = target as Partial<Element>;
  return candidate.nodeType === 1 && typeof candidate.closest === "function";
}

function isHTMLElement(root: Document, target: EventTarget | null): target is HTMLElement {
  const HTMLElementConstructor = root.defaultView?.HTMLElement;
  if (HTMLElementConstructor) {
    return target instanceof HTMLElementConstructor;
  }
  if (!target || typeof target !== "object") {
    return false;
  }
  const candidate = target as Partial<HTMLElement>;
  return candidate.nodeType === 1 && candidate.namespaceURI === "http://www.w3.org/1999/xhtml";
}
