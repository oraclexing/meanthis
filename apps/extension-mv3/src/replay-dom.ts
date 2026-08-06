import type {
  ReplayLocatorLike,
  ReplayPageLike,
  ReplayQueryScopeLike,
} from "@meanthis/replay";
import { resolveReplayLocator } from "@meanthis/replay";
import type { UIAttachmentLocator } from "@meanthis/schema";

const domLocatorElements = new WeakMap<ReplayLocatorLike, HTMLElement[]>();

interface DomReplayCache {
  elementsByScope: WeakMap<HTMLElement, HTMLElement[]>;
  accessibleNames: WeakMap<HTMLElement, string | null>;
  roles: WeakMap<HTMLElement, string | null>;
  normalizedText: WeakMap<HTMLElement, string | null>;
  visibility: WeakMap<HTMLElement, boolean>;
}

export function createDomReplayPage(root: Document): ReplayPageLike {
  return createDomScope(root, [root.body], true, createDomReplayCache());
}

export async function resolveDomReplayTarget(
  root: Document,
  locators: ReadonlyArray<Pick<UIAttachmentLocator, "strategy" | "value" | "confidence">>,
): Promise<HTMLElement | null> {
  return (await resolveDomReplayTargetResult(root, locators)).target;
}

export function isDomReplayTargetVisible(target: HTMLElement): boolean {
  return isDomVisible(target, createDomReplayCache());
}

export type DomReplayTargetResult =
  | { status: "restored"; target: HTMLElement }
  | { status: "missing" | "ambiguous"; target: null };

export async function resolveDomReplayTargetResult(
  root: Document,
  locators: ReadonlyArray<Pick<UIAttachmentLocator, "strategy" | "value" | "confidence">>,
): Promise<DomReplayTargetResult> {
  const page = createDomReplayPage(root);
  let sawAmbiguousLocator = false;
  for (const candidate of locators) {
    let locator: ReplayLocatorLike | null = null;
    try {
      if (candidate.strategy === "coordinates" || candidate.strategy === "xpath") continue;
      locator = resolveReplayLocator(
        page,
        candidate.strategy,
        candidate.value,
      ).locator;
      if (!locator) continue;
      const matchCount = await locator.count();
      if (matchCount > 1) {
        sawAmbiguousLocator = true;
        continue;
      }
      if (matchCount !== 1 || !(await locator.isVisible())) {
        continue;
      }
    } catch {
      continue;
    }

    const target = domLocatorElements.get(locator)?.[0] ?? null;
    if (target?.isConnected) return { status: "restored", target };
  }
  return {
    status: sawAmbiguousLocator ? "ambiguous" : "missing",
    target: null,
  };
}

function createDomScope(
  root: Document,
  scopes: HTMLElement[],
  includeScopeRoots: boolean,
  cache: DomReplayCache,
): ReplayQueryScopeLike {
  return {
    frameLocator: (selector) => createFrameScope(root, scopes, selector, cache),
    locator: (selector) => domLocator(root, queryDescendants(scopes, selector, cache), cache),
    getByRole: (role, options) =>
      domLocator(root, findByRole(scopes, role, options?.name, includeScopeRoots, cache), cache),
    getByLabel: (text) =>
      domLocator(root, findByLabel(scopes, text, includeScopeRoots, cache), cache),
    getByTestId: (text) =>
      domLocator(root, findByAttribute(scopes, "data-testid", text, includeScopeRoots, cache), cache),
    getByText: (text) =>
      domLocator(root, findByText(scopes, text, includeScopeRoots, cache), cache),
    getByAltText: (text) =>
      domLocator(root, findByAttribute(scopes, "alt", text, includeScopeRoots, cache), cache),
    getByTitle: (text) =>
      domLocator(root, findByAttribute(scopes, "title", text, includeScopeRoots, cache), cache),
    getByPlaceholder: (text) =>
      domLocator(root, findByAttribute(scopes, "placeholder", text, includeScopeRoots, cache), cache),
  };
}

function domLocator(
  root: Document,
  elements: HTMLElement[],
  cache: DomReplayCache,
): ReplayLocatorLike {
  const locator: ReplayLocatorLike = {
    ...createDomScope(root, elements, false, cache),
    count: async () => elements.length,
    isVisible: async () => Boolean(elements[0] && isDomVisible(elements[0], cache)),
  };
  domLocatorElements.set(locator, elements);
  return locator;
}

function createFrameScope(
  root: Document,
  scopes: HTMLElement[],
  selector: string,
  cache: DomReplayCache,
): ReplayQueryScopeLike {
  const bodies: HTMLElement[] = [];
  for (const element of queryDescendants(scopes, selector, cache)) {
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
  return createDomScope(root, dedupeElements(bodies), true, cache);
}

function findByRole(
  scopes: HTMLElement[],
  role: string,
  name: string | undefined,
  includeScopeRoots: boolean,
  cache: DomReplayCache,
): HTMLElement[] {
  return queryCandidates(scopes, includeScopeRoots, cache).filter((element) => {
    if (inferDomRole(element, cache) !== role || !isDomVisible(element, cache)) {
      return false;
    }
    return name === undefined || includesIgnoreCase(getDomAccessibleName(element, cache), name);
  });
}

function findByLabel(
  scopes: HTMLElement[],
  label: string,
  includeScopeRoots: boolean,
  cache: DomReplayCache,
): HTMLElement[] {
  const controls: HTMLElement[] = [];
  queryCandidates(scopes, includeScopeRoots, cache)
    .filter((element) => element.tagName.toLowerCase() === "label")
    .forEach((labelElement) => {
      if (getNormalizedText(labelElement, cache) !== label) {
        return;
      }

      const control = (labelElement as HTMLLabelElement).control;
      if (isHtmlElement(control) && belongsToScopes(control, scopes, cache)) {
        controls.push(control);
      }

      const nested = labelElement.querySelector<HTMLElement>("input, textarea, select");
      if (nested) {
        controls.push(nested);
      }
    });
  return orderElementsByTraversal(scopes, controls, cache);
}

function findByText(
  scopes: HTMLElement[],
  text: string,
  includeScopeRoots: boolean,
  cache: DomReplayCache,
): HTMLElement[] {
  return queryCandidates(scopes, includeScopeRoots, cache).filter((element) =>
    hasOwnMatchingText(element, text, cache),
  );
}

function findByAttribute(
  scopes: HTMLElement[],
  attribute: string,
  text: string,
  includeScopeRoots: boolean,
  cache: DomReplayCache,
): HTMLElement[] {
  return queryCandidates(scopes, includeScopeRoots, cache).filter(
    (element) => element.getAttribute(attribute) === text,
  );
}

function queryCandidates(
  scopes: HTMLElement[],
  includeScopeRoots: boolean,
  cache: DomReplayCache,
): HTMLElement[] {
  return dedupeElements(
    scopes.flatMap((scope) => {
      const elements = collectElements(scope, cache);
      return includeScopeRoots ? elements : elements.slice(1);
    }),
  );
}

function queryDescendants(
  scopes: HTMLElement[],
  selector: string,
  cache: DomReplayCache,
): HTMLElement[] {
  try {
    return dedupeElements(
      scopes.flatMap((scope) =>
        collectElements(scope, cache)
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
  cache: DomReplayCache,
): HTMLElement[] {
  const remaining = new Set(elements);
  return queryCandidates(scopes, true, cache).filter((element) => remaining.delete(element));
}

function belongsToScopes(
  element: HTMLElement,
  scopes: HTMLElement[],
  cache: DomReplayCache,
): boolean {
  return scopes.some((scope) => collectElements(scope, cache).includes(element));
}

function isHtmlElement(element: Element | null): element is HTMLElement {
  return element?.namespaceURI === "http://www.w3.org/1999/xhtml";
}

function collectElements(scope: HTMLElement, cache: DomReplayCache): HTMLElement[] {
  const cached = cache.elementsByScope.get(scope);
  if (cached) return cached;
  const elements: HTMLElement[] = [];
  const visit = (element: HTMLElement): void => {
    if (element.hasAttribute("data-ui-attach-overlay-root")) return;
    elements.push(element);
    Array.from(element.children).forEach((child) => visit(child as HTMLElement));
    Array.from(element.shadowRoot?.children ?? []).forEach((child) =>
      visit(child as HTMLElement),
    );
  };
  visit(scope);
  cache.elementsByScope.set(scope, elements);
  return elements;
}

function inferDomRole(element: HTMLElement, cache: DomReplayCache): string | null {
  if (cache.roles.has(element)) return cache.roles.get(element) ?? null;
  const role = inferUncachedDomRole(element);
  cache.roles.set(element, role);
  return role;
}

function inferUncachedDomRole(element: HTMLElement): string | null {
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

function inferInputRole(input: HTMLInputElement): string | null {
  const type = input.type.toLowerCase();
  if (type === "password") return null;
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

function getDomAccessibleName(element: HTMLElement, cache: DomReplayCache): string | null {
  if (cache.accessibleNames.has(element)) {
    return cache.accessibleNames.get(element) ?? null;
  }
  const name = getUncachedDomAccessibleName(element);
  cache.accessibleNames.set(element, name);
  return name;
}

function getUncachedDomAccessibleName(element: HTMLElement): string | null {
  const ariaLabel = normalizeText(element.getAttribute("aria-label"));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => findIdReference(element, id) ?? "")
      .join(" ");
    const normalized = normalizeText(text);
    if (normalized) {
      return normalized;
    }
  }

  const inputButtonValue = getInputButtonAccessibleName(element);
  if (inputButtonValue) {
    return inputButtonValue;
  }

  return normalizeText(element.textContent) ?? normalizeText(element.getAttribute("title"));
}

function getInputButtonAccessibleName(element: HTMLElement): string | null {
  if (element.tagName.toLowerCase() !== "input") {
    return null;
  }
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  return ["button", "submit", "reset"].includes(type)
    ? normalizeText(element.getAttribute("value"))
    : null;
}

function findIdReference(element: HTMLElement, id: string): string | null {
  const elementRoot = element.getRootNode() as Node & {
    getElementById?: (value: string) => Element | null;
  };
  return elementRoot.getElementById?.(id)?.textContent ?? null;
}

function hasOwnMatchingText(
  element: HTMLElement,
  text: string,
  cache: DomReplayCache,
): boolean {
  if (getNormalizedText(element, cache) !== text) {
    return false;
  }

  return !Array.from(element.children).some(
    (child) => isHtmlElement(child) && getNormalizedText(child, cache) === text,
  );
}

function isDomVisible(element: HTMLElement, cache: DomReplayCache): boolean {
  if (cache.visibility.has(element)) return cache.visibility.get(element) === true;
  const visible = isUncachedDomVisible(element);
  cache.visibility.set(element, visible);
  return visible;
}

function isUncachedDomVisible(element: HTMLElement): boolean {
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

function getNormalizedText(element: HTMLElement, cache: DomReplayCache): string | null {
  if (cache.normalizedText.has(element)) {
    return cache.normalizedText.get(element) ?? null;
  }
  const text = normalizeText(element.textContent);
  cache.normalizedText.set(element, text);
  return text;
}

function createDomReplayCache(): DomReplayCache {
  return {
    elementsByScope: new WeakMap(),
    accessibleNames: new WeakMap(),
    roles: new WeakMap(),
    normalizedText: new WeakMap(),
    visibility: new WeakMap(),
  };
}
