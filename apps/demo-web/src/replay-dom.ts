import type {
  ReplayLocatorLike,
  ReplayPageLike,
  ReplayQueryScopeLike,
} from "@meanthis/replay";

export function createDomReplayPage(root: Document, scope: HTMLElement): ReplayPageLike {
  return createDomScope(root, [scope], true);
}

function createDomScope(
  root: Document,
  scopes: HTMLElement[],
  includeScopeRoots: boolean,
): ReplayQueryScopeLike {
  return {
    frameLocator: (selector) => createFrameScope(root, scopes, selector),
    locator: (selector) => domLocator(root, queryDescendants(scopes, selector)),
    getByRole: (role, options) =>
      domLocator(root, findByRole(scopes, role, options?.name, includeScopeRoots)),
    getByLabel: (text) => domLocator(root, findByLabel(scopes, text, includeScopeRoots)),
    getByTestId: (text) =>
      domLocator(root, findByAttribute(scopes, "data-testid", text, includeScopeRoots)),
    getByText: (text) => domLocator(root, findByText(scopes, text, includeScopeRoots)),
    getByAltText: (text) =>
      domLocator(root, findByAttribute(scopes, "alt", text, includeScopeRoots)),
    getByTitle: (text) =>
      domLocator(root, findByAttribute(scopes, "title", text, includeScopeRoots)),
    getByPlaceholder: (text) =>
      domLocator(root, findByAttribute(scopes, "placeholder", text, includeScopeRoots)),
  };
}

function domLocator(root: Document, elements: HTMLElement[]): ReplayLocatorLike {
  return {
    ...createDomScope(root, elements, false),
    count: async () => elements.length,
    isVisible: async () => Boolean(elements[0] && isDomVisible(elements[0])),
  };
}

function createFrameScope(
  root: Document,
  scopes: HTMLElement[],
  selector: string,
): ReplayQueryScopeLike {
  const bodies: HTMLElement[] = [];
  for (const element of queryDescendants(scopes, selector)) {
    if (element.tagName.toLowerCase() !== "iframe") {
      continue;
    }
    try {
      const body = (element as HTMLIFrameElement).contentDocument?.body;
      if (body) {
        bodies.push(body);
      }
    } catch {
      // Cross-origin frames are intentionally represented as empty scopes.
    }
  }
  return createDomScope(root, dedupeElements(bodies), true);
}

function findByRole(
  scopes: HTMLElement[],
  role: string,
  name: string | undefined,
  includeScopeRoots: boolean,
): HTMLElement[] {
  return queryCandidates(scopes, includeScopeRoots).filter((element) => {
    const accessibleName = getDomAccessibleName(element);
    return (
      inferDomRole(element) === role &&
      (name === undefined || includesIgnoreCase(accessibleName, name))
    );
  });
}

function findByLabel(
  scopes: HTMLElement[],
  label: string,
  includeScopeRoots: boolean,
): HTMLElement[] {
  const controls: HTMLElement[] = [];
  queryCandidates(scopes, includeScopeRoots)
    .filter((element) => element.tagName.toLowerCase() === "label")
    .forEach((labelElement) => {
      if (normalizeText(labelElement.textContent) !== label) {
        return;
      }

      const htmlFor = (labelElement as HTMLLabelElement).htmlFor;
      if (htmlFor) {
        const explicit = labelElement.ownerDocument.getElementById(htmlFor);
        if (isHtmlElement(explicit) && belongsToScopes(explicit, scopes)) {
          controls.push(explicit);
        }
      }

      const nested = labelElement.querySelector<HTMLElement>("input, textarea, select");
      if (nested) {
        controls.push(nested);
      }
    });
  return orderElementsByTraversal(scopes, controls);
}

function findByText(
  scopes: HTMLElement[],
  text: string,
  includeScopeRoots: boolean,
): HTMLElement[] {
  return queryCandidates(scopes, includeScopeRoots).filter((element) =>
    hasOwnMatchingText(element, text),
  );
}

function findByAttribute(
  scopes: HTMLElement[],
  attribute: string,
  text: string,
  includeScopeRoots: boolean,
): HTMLElement[] {
  return queryCandidates(scopes, includeScopeRoots).filter(
    (element) => element.getAttribute(attribute) === text,
  );
}

function queryCandidates(scopes: HTMLElement[], includeScopeRoots: boolean): HTMLElement[] {
  return dedupeElements(
    scopes.flatMap((scope) => {
      const elements = collectElements(scope);
      return includeScopeRoots ? elements : elements.slice(1);
    }),
  );
}

function queryDescendants(scopes: HTMLElement[], selector: string): HTMLElement[] {
  try {
    return dedupeElements(
      scopes.flatMap((scope) =>
        collectElements(scope)
          .slice(1)
          .filter((element) => element.matches(selector)),
      ),
    );
  } catch {
    return [];
  }
}

function dedupeElements(elements: HTMLElement[]): HTMLElement[] {
  return [...new Set(elements)];
}

function orderElementsByTraversal(
  scopes: HTMLElement[],
  elements: HTMLElement[],
): HTMLElement[] {
  const remaining = new Set(elements);
  return queryCandidates(scopes, true).filter((element) => remaining.delete(element));
}

function belongsToScopes(element: HTMLElement, scopes: HTMLElement[]): boolean {
  return scopes.some((scope) => scope === element || scope.contains(element));
}

function isHtmlElement(element: Element | null): element is HTMLElement {
  return element?.namespaceURI === "http://www.w3.org/1999/xhtml";
}

function collectElements(scope: HTMLElement): HTMLElement[] {
  return [scope, ...Array.from(scope.querySelectorAll<HTMLElement>("*"))];
}

function inferDomRole(element: HTMLElement): string | null {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === "button") return "button";
  if (tagName === "a" && element.hasAttribute("href")) return "link";
  if (/^h[1-6]$/.test(tagName)) return "heading";
  if (tagName === "textarea") return "textbox";
  if (tagName === "select") return "combobox";
  if (tagName === "input") {
    return inferInputRole(element as HTMLInputElement);
  }
  return null;
}

function inferInputRole(input: HTMLInputElement): string {
  const type = input.type.toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "range") return "slider";
  if (type === "search" && input.hasAttribute("list")) return "combobox";
  if (type === "search") return "searchbox";
  if (["button", "submit", "reset"].includes(type)) return "button";
  return "textbox";
}

function includesIgnoreCase(value: string | null, expected: string): boolean {
  return value?.toLowerCase().includes(expected.toLowerCase()) === true;
}

function getDomAccessibleName(element: HTMLElement): string | null {
  const ariaLabel = normalizeText(element.getAttribute("aria-label"));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    const normalized = normalizeText(text);
    if (normalized) {
      return normalized;
    }
  }

  return normalizeText(element.textContent) ?? normalizeText(element.getAttribute("title"));
}

function hasOwnMatchingText(element: HTMLElement, text: string): boolean {
  if (normalizeText(element.textContent) !== text) {
    return false;
  }

  return !Array.from(element.children).some((child) => normalizeText(child.textContent) === text);
}

function isDomVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current) {
    const style =
      current.ownerDocument.defaultView?.getComputedStyle(current) ?? getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      (style.opacity !== "" && Number(style.opacity) === 0) ||
      current.hidden
    ) {
      return false;
    }
    const parent = getComposedParentElement(current);
    if (parent === undefined) {
      return false;
    }
    current = parent;
  }
  return true;
}

function getComposedParentElement(
  element: HTMLElement,
): HTMLElement | null | undefined {
  if (element.parentElement) {
    return element.parentElement;
  }
  const host = (element.getRootNode() as ShadowRoot).host;
  if (isHtmlElement(host)) {
    return host;
  }
  try {
    const frameElement = element.ownerDocument.defaultView?.frameElement ?? null;
    return isHtmlElement(frameElement) ? frameElement : null;
  } catch {
    return undefined;
  }
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}
