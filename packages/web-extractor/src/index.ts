import {
  createAttachmentId,
  isUIAttachmentSourceAnchor,
  UI_ATTACHMENT_COMPUTED_STYLE_FIELDS,
  UI_ATTACHMENT_COMPUTED_STYLE_VALUE_MAX_BYTES,
  UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS,
  UI_ATTACHMENT_SCHEMA_VERSION,
  UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
  UI_ATTACH_SOURCE_BUILD_ID_ATTRIBUTE,
  UI_ATTACH_SOURCE_CALLSITE_BUILD_ID_ATTRIBUTE,
  UI_ATTACH_SOURCE_CALLSITE_ID_ATTRIBUTE,
  UI_ATTACH_SOURCE_ID_ATTRIBUTE,
  type UIAttachment,
  type UIAttachmentContentPart,
  type UIAttachmentComputedStyleField,
  type UIAttachmentDisclosureMode,
  type UIAttachmentElement,
  type UIAttachmentLocator,
  type UIAttachmentLocatorBundle,
  type UIAttachmentPolicy,
  type UIAttachmentSourceAnchor,
} from "@meanthis/schema";

export interface ExtractElementAttachmentOptions {
  now?: () => Date;
  idSeed?: string;
  locationHref?: string;
  documentTitle?: string;
  disclosureMode?: UIAttachmentDisclosureMode;
}

export type DeriveAttachmentDisclosureResult =
  | {
      ok: true;
      attachment: UIAttachment;
    }
  | {
      ok: false;
      reason: string;
    };

interface BuiltElement {
  elementInfo: UIAttachmentElement;
  conciseRoleName: string | null;
}

interface AccessibleNameResult {
  value: string | null;
  conciseRoleName: string | null;
}

interface DisclosureAudit {
  disclosureMode: UIAttachmentDisclosureMode;
  redactedFields: Set<string>;
  sensitiveHints: Set<string>;
  includedSensitiveFields: Set<string>;
}

interface AccessibleTextBudget {
  remainingNodes: number;
  remainingCharacters: number;
  remainingSlotScanNodes: number;
  slotAssignmentIndexes: WeakMap<ShadowRoot, SlotAssignmentIndex>;
}

interface SlotAssignmentIndex {
  assignments: Map<HTMLSlotElement, Node[]>;
  complete: boolean;
}

interface StructuralSelectorBudget {
  remainingSiblings: number;
}

interface ScopedTargetSelector {
  value: string;
  combinator: " " | " > ";
}

const ACCESSIBLE_TEXT_SKIPPED_TAGS = new Set(["script", "style", "template", "noscript"]);
const MAX_ACCESSIBLE_TEXT_NODES = 10_000;
const MAX_ACCESSIBLE_TEXT_DEPTH = 256;
const MAX_ACCESSIBLE_TEXT_CHARACTERS = 16_000;
const MAX_ACCESSIBLE_SLOT_SCAN_NODES = 10_000;
const MAX_SELECTED_DOM_TEXT_NODES = 10_000;
const MAX_PAGE_CONTROLLED_TEXT_CHARACTERS = 16_000;
const MAX_ELEMENT_ATTRIBUTES = 256;
const MAX_FORM_LABELS = 64;
const MAX_ATTACHMENT_ID_TEXT_SEED_CHARACTERS = 128;
const MAX_CONTENT_PARTS = 64;
const MAX_CONTENT_PART_NODES = 512;
const MAX_CONTENT_PART_BYTES = 16_000;
const MIN_RESERVED_SEMANTIC_CONTENT_PART_BYTES = 64;
const MAX_ATTACHMENT_SERIALIZED_CHARACTERS = 128 * 1024;
const MAX_EMBEDDED_URL_STARTS = 64;
const MAX_ARIA_LABEL_REFERENCES = 64;
const TRUNCATION_MARKER = "[truncated]";
const MIN_CONCISE_ROLE_NAME_CHARACTERS = 4;
const MAX_CONCISE_ROLE_NAME_CHARACTERS = 80;
const MAX_STRUCTURAL_SELECTOR_DEPTH = 12;
const MAX_STRUCTURAL_SELECTOR_LENGTH = 512;
const MAX_STRUCTURAL_SIBLING_SCAN = 1_000;
const MAX_ANCHORED_SELECTOR_DEPTH = 24;
const MAX_ANCHOR_LINK_SCAN = 40;
const MAX_ANCHOR_HREF_LENGTH = 256;
const STABLE_DATA_ATTRIBUTE_NAME = /^data-[a-z0-9]+(?:-[a-z0-9]+)+$/;

export function extractElementAttachment(
  element: HTMLElement,
  options: ExtractElementAttachmentOptions = {},
): UIAttachment {
  const rect = element.getBoundingClientRect();
  const ownerDocument = element.ownerDocument;
  const computed =
    ownerDocument.defaultView?.getComputedStyle(element) ?? getComputedStyle(element);
  const now = options.now ?? (() => new Date());
  const audit = createDisclosureAudit(options.disclosureMode);
  const selectedText = collectSelectedDomText(element);
  const { elementInfo, conciseRoleName } = buildElement(
    element,
    selectedText,
    rect,
    computed,
    audit,
  );
  const selectorHints = buildSelectorHints(element, selectedText);
  const context = {
    parentSummary: summarizeParent(element, audit),
    nearbyText: collectNearbyText(element, audit),
    selectorHints: deriveSelectorHintsDisclosure(
      selectorHints,
      "context.selectorHints",
      audit,
    ),
  };
  const sourceUrl = sanitizeSourceUrl(options.locationHref ?? ownerDocument.URL, audit);
  const sourceAnchor = extractOpaqueSourceAnchor(element);

  const attachment: UIAttachment = {
    schemaVersion: UI_ATTACHMENT_SCHEMA_VERSION,
    id: createDisclosedAttachmentId(options.idSeed ?? buildIdSeed(element, selectedText), audit),
    capturedAt: now().toISOString(),
    source: {
      kind: "web",
      url: sourceUrl,
      title: redactText(
        options.documentTitle ?? ownerDocument.title,
        "source.title",
        audit,
      ),
    },
    ...(sourceAnchor === undefined ? {} : { sourceAnchor }),
    element: elementInfo,
    style: {
      display: computed.display || null,
      color: computed.color || null,
      backgroundColor: computed.backgroundColor || null,
      ...captureComputedStyleFacts(computed, audit),
    },
    context,
    locatorBundle: deriveLocatorBundleDisclosure(
      buildLocatorBundle(element, elementInfo, selectorHints, conciseRoleName),
      audit,
    ),
    policy: buildPolicy(audit),
    artifacts: {
      screenshotCrop: null,
      overlayImage: null,
    },
  };
  return enforceAttachmentBudget(attachment);
}

function enforceAttachmentBudget(attachment: UIAttachment): UIAttachment {
  if (JSON.stringify(attachment).length > MAX_ATTACHMENT_SERIALIZED_CHARACTERS) {
    throw new Error(
      `MeanThis attachment exceeded ${MAX_ATTACHMENT_SERIALIZED_CHARACTERS} serialized characters.`,
    );
  }
  return attachment;
}

function captureComputedStyleFacts(
  computed: CSSStyleDeclaration,
  audit: DisclosureAudit,
): Record<UIAttachmentComputedStyleField, string | null> {
  const facts = {} as Record<UIAttachmentComputedStyleField, string | null>;
  for (const field of UI_ATTACHMENT_COMPUTED_STYLE_FIELDS) {
    const value = redactOptionalDisclosureValue(
      computed[field] || null,
      `style.${field}`,
      audit,
    );
    facts[field] = typeof value === "string" &&
        utf8ByteLength(value) <= UI_ATTACHMENT_COMPUTED_STYLE_VALUE_MAX_BYTES
      ? value
      : null;
  }
  return facts;
}

function deriveComputedStyleFactsDisclosure(
  style: UIAttachment["style"],
  audit: DisclosureAudit,
): Partial<Record<UIAttachmentComputedStyleField, string | null>> {
  const facts: Partial<Record<UIAttachmentComputedStyleField, string | null>> = {};
  for (const field of UI_ATTACHMENT_COMPUTED_STYLE_FIELDS) {
    if (!Object.hasOwn(style, field)) continue;
    facts[field] = redactOptionalDisclosureValue(
      style[field],
      `style.${field}`,
      audit,
    ) ?? null;
  }
  return facts;
}

function extractOpaqueSourceAnchor(
  element: HTMLElement,
): UIAttachmentSourceAnchor | undefined {
  return extractOpaqueSourceAnchorPair(
    element,
    UI_ATTACH_SOURCE_CALLSITE_BUILD_ID_ATTRIBUTE,
    UI_ATTACH_SOURCE_CALLSITE_ID_ATTRIBUTE,
  ) ?? extractOpaqueSourceAnchorPair(
    element,
    UI_ATTACH_SOURCE_BUILD_ID_ATTRIBUTE,
    UI_ATTACH_SOURCE_ID_ATTRIBUTE,
  );
}

function extractOpaqueSourceAnchorPair(
  element: HTMLElement,
  buildIdAttribute: string,
  sourceIdAttribute: string,
): UIAttachmentSourceAnchor | undefined {
  const buildId = element.getAttribute(buildIdAttribute);
  const sourceId = element.getAttribute(sourceIdAttribute);
  if (buildId === null || sourceId === null) return undefined;

  const candidate = {
    schemaVersion: UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION,
    kind: "ui-attach.opaque-source-anchor",
    buildId,
    sourceId,
  };
  return isUIAttachmentSourceAnchor(candidate) ? candidate : undefined;
}

export function deriveAttachmentDisclosure(
  attachment: UIAttachment,
  disclosureMode: UIAttachmentDisclosureMode,
): DeriveAttachmentDisclosureResult {
  const sourceMode = normalizeDisclosureMode(attachment.policy.disclosureMode);
  const targetMode = normalizeDisclosureMode(disclosureMode);
  if (!canDeriveDisclosure(sourceMode, targetMode)) {
    return {
      ok: false,
      reason: `Cannot derive ${targetMode} disclosure from ${sourceMode} capture. Capture again with ${targetMode} disclosure.`,
    };
  }

  const audit = createDisclosureAudit(targetMode);
  const sourceUrl = sanitizeSourceUrl(attachment.source.url, audit);
  const sourceTitle = redactText(attachment.source.title, "source.title", audit);
  const elementInfo = {
    ...attachment.element,
    tagName: redactDisclosureValue(attachment.element.tagName, "element.tagName", audit),
    role: redactText(attachment.element.role, "element.role", audit),
    text: redactText(attachment.element.text, "element.text", audit),
    accessibleName: redactText(
      attachment.element.accessibleName,
      "element.accessibleName",
      audit,
    ),
    ...(attachment.element.contentParts === undefined
      ? {}
      : { contentParts: deriveContentPartsDisclosure(attachment.element.contentParts, audit) }),
  };
  const style = {
    display: redactOptionalDisclosureValue(
      attachment.style.display,
      "style.display",
      audit,
    ) ?? null,
    color: redactOptionalDisclosureValue(attachment.style.color, "style.color", audit) ?? null,
    backgroundColor: redactOptionalDisclosureValue(
      attachment.style.backgroundColor,
      "style.backgroundColor",
      audit,
    ) ?? null,
    ...deriveComputedStyleFactsDisclosure(attachment.style, audit),
  };
  const context = {
    ...attachment.context,
    parentSummary: redactText(
      attachment.context.parentSummary,
      "context.parentSummary",
      audit,
    ),
    nearbyText: attachment.context.nearbyText
      .map((text) => redactText(text, "context.nearbyText", audit))
      .filter((text): text is string => text !== null),
    selectorHints: deriveSelectorHintsDisclosure(
      attachment.context.selectorHints,
      "context.selectorHints",
      audit,
    ),
  };
  const locatorBundle = deriveLocatorBundleDisclosure(attachment.locatorBundle, audit);
  const artifacts = deriveArtifactsDisclosure(attachment.artifacts, audit);
  const structuralRedaction = redactKnownSensitiveAttachmentFields(
    {
      ...attachment,
      id: deriveAttachmentIdDisclosure(attachment.id, audit),
      source: {
        ...attachment.source,
        url: sourceUrl,
        title: sourceTitle,
      },
      element: elementInfo,
      style,
      context,
      locatorBundle,
      artifacts,
    },
    attachment.policy,
    sourceMode,
    targetMode,
  );
  const structurallyBudgetedAttachment =
    structuralRedaction.attachment.element.contentParts === undefined
      ? structuralRedaction.attachment
      : {
          ...structuralRedaction.attachment,
          element: {
            ...structuralRedaction.attachment.element,
            contentParts: deriveContentPartsDisclosure(
              structuralRedaction.attachment.element.contentParts,
              audit,
            ),
          },
        };
  carryKnownSensitiveFields(attachment.policy, audit);
  for (const field of structuralRedaction.redactedFields) {
    markSensitiveField(audit, field, true);
  }
  const derivedPolicy = buildPolicy(audit);
  const capabilityPolicy = targetMode === "full_debug"
    ? attachment.policy
    : {
        ...attachment.policy,
        allowScreenshot: false,
        allowDomSnippet: false,
        allowNetworkSend: false,
        allowedDomains: [],
      };

  return {
    ok: true,
    attachment: enforceAttachmentBudget({
      ...structurallyBudgetedAttachment,
      policy: {
        ...capabilityPolicy,
        disclosureMode: derivedPolicy.disclosureMode,
        redactionLevel: derivedPolicy.redactionLevel,
        redactedFields: derivedPolicy.redactedFields,
        sensitiveHints: derivedPolicy.sensitiveHints,
        includedSensitiveFields: derivedPolicy.includedSensitiveFields,
      },
    }),
  };
}

function buildElement(
  element: HTMLElement,
  selectedText: string,
  rect: DOMRect,
  computed: CSSStyleDeclaration,
  audit: DisclosureAudit,
): BuiltElement {
  const accessibleName = getAccessibleName(element, audit);
  return {
    elementInfo: {
      tagName: element.tagName.toLowerCase(),
      role: redactText(inferRole(element), "element.role", audit),
      text: redactText(selectedText, "element.text", audit),
      accessibleName: accessibleName.value,
      contentParts: collectElementContentParts(element, selectedText, audit),
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      visible: isVisible(element, rect, computed),
      enabled: !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
    },
    conciseRoleName: accessibleName.conciseRoleName,
  };
}

function collectElementContentParts(
  root: HTMLElement,
  selectedText: string,
  audit: DisclosureAudit,
): UIAttachmentContentPart[] {
  type ContentPartCandidate = {
    element: HTMLElement;
    kind: UIAttachmentContentPart["kind"];
    role: string | null;
    textParts: string[];
    textTruncated: boolean;
    includeExplicitAccessibleName: boolean;
  };
  type SemanticContext = {
    element: HTMLElement;
    role: string | null;
    currentCandidate: ContentPartCandidate | null;
  };

  const parts: UIAttachmentContentPart[] = [];
  const candidates: ContentPartCandidate[] = [];
  let visitedNodes = 0;
  let remainingTextCharacters = MAX_PAGE_CONTROLLED_TEXT_CHARACTERS;
  const byteBudget = { remaining: MAX_CONTENT_PART_BYTES };
  const inlineFlowCache = new WeakMap<HTMLElement, boolean>();

  const createCandidate = (
    element: HTMLElement,
    role: string | null,
    includeExplicitAccessibleName: boolean,
  ): ContentPartCandidate => {
    const candidate = {
      element,
      kind: inferContentPartKind(element, role),
      role,
      textParts: [],
      textTruncated: false,
      includeExplicitAccessibleName,
    };
    candidates.push(candidate);
    return candidate;
  };

  const appendCandidateText = (candidate: ContentPartCandidate, value: string) => {
    if (!value || remainingTextCharacters <= 0) return;
    const part = value.slice(0, remainingTextCharacters);
    if (part) {
      candidate.textParts.push(part);
      remainingTextCharacters -= part.length;
    }
    if (part.length < value.length) candidate.textTruncated = true;
  };

  const addPart = (
    candidate: ContentPartCandidate,
    partByteBudget: { remaining: number },
  ) => {
    if (parts.length >= MAX_CONTENT_PARTS || partByteBudget.remaining <= 0) return;
    const { element, kind, role } = candidate;
    const text = getCandidateText(candidate);
    const partText = takeBudgetedContentPartText(
      text,
      "element.text",
      audit,
      partByteBudget,
    );
    if (!partText && kind === "text") return;
    const explicitAccessibleName = candidate.includeExplicitAccessibleName
      ? getExplicitContentPartAccessibleName(element)
      : null;
    const accessibleName = takeBudgetedContentPartText(
      explicitAccessibleName ?? partText,
      "element.accessibleName",
      audit,
      partByteBudget,
    );
    if (!partText && !accessibleName) return;
    parts.push({
      kind,
      tagName: element.tagName.toLowerCase(),
      role: redactText(role, "element.role", audit),
      text: partText,
      accessibleName,
    });
  };

  const visit = (
    element: HTMLElement,
    inheritedSemanticContext: SemanticContext | null,
  ) => {
    if (visitedNodes >= MAX_CONTENT_PART_NODES) return;
    visitedNodes += 1;
    if (isContentPartHidden(element)) return;

    const role = inferRole(element);
    const kind = inferContentPartKind(element, role);
    let semanticContext = inheritedSemanticContext;
    if (kind !== "text") {
      if (inheritedSemanticContext) inheritedSemanticContext.currentCandidate = null;
      semanticContext = {
        element,
        role,
        currentCandidate: createCandidate(element, role, true),
      };
    }

    let child: ChildNode | null = element.firstChild;
    while (child) {
      if (visitedNodes >= MAX_CONTENT_PART_NODES) break;
      const nextSibling = child.nextSibling;
      if (
        child.nodeType === child.TEXT_NODE ||
        child.nodeType === child.CDATA_SECTION_NODE
      ) {
        visitedNodes += 1;
        const value = child.nodeValue ?? "";
        if (value) {
          let candidate: ContentPartCandidate;
          if (semanticContext) {
            candidate = semanticContext.currentCandidate ??= createCandidate(
              semanticContext.element,
              semanticContext.role,
              false,
            );
          } else {
            candidate = createCandidate(element, role, true);
          }
          appendCandidateText(candidate, value);
        }
      } else if (child instanceof HTMLElement) {
        visit(child, semanticContext);
      } else {
        visitedNodes += 1;
      }
      child = nextSibling;
    }
  };

  visit(root, null);

  const coalescedCandidates: ContentPartCandidate[] = [];
  for (const candidate of candidates) {
    const previous = coalescedCandidates.at(-1);
    if (previous && canCoalesceGenericText(previous, candidate)) {
      previous.textParts.push(...candidate.textParts);
      previous.textTruncated ||= candidate.textTruncated;
      continue;
    }
    coalescedCandidates.push(candidate);
  }

  const meaningfulCandidates = coalescedCandidates.filter(hasPotentialContent);
  const selectedCandidates = selectBoundedCandidates(meaningfulCandidates);
  let laterSemanticCandidates = selectedCandidates.filter(
    isPrioritySemanticCandidate,
  ).length;
  for (const candidate of selectedCandidates) {
    if (parts.length >= MAX_CONTENT_PARTS || byteBudget.remaining <= 0) break;
    if (isPrioritySemanticCandidate(candidate)) laterSemanticCandidates -= 1;
    withReservedContentPartByteBudget(
      byteBudget,
      laterSemanticCandidates,
      (partByteBudget) => addPart(candidate, partByteBudget),
    );
  }
  if (parts.length === 0) {
    const role = inferRole(root);
    const fallback: ContentPartCandidate = {
      element: root,
      kind: inferContentPartKind(root, role),
      role,
      textParts: [selectedText],
      textTruncated: false,
      includeExplicitAccessibleName: true,
    };
    addPart(fallback, byteBudget);
  }
  return parts;

  function getCandidateText(candidate: ContentPartCandidate): string {
    const collectedText = candidate.textParts.join("");
    return candidate.textTruncated
      ? markTextTruncated(collectedText, MAX_PAGE_CONTROLLED_TEXT_CHARACTERS)
      : collectedText;
  }

  function getExplicitContentPartAccessibleName(element: HTMLElement): string | null {
    return element.getAttribute("aria-label") ??
      element.getAttribute("alt") ??
      getInputButtonAccessibleName(element) ??
      element.getAttribute("title");
  }

  function hasPotentialContent(candidate: ContentPartCandidate): boolean {
    if (normalizeText(getCandidateText(candidate))) return true;
    return candidate.includeExplicitAccessibleName &&
      hasExplicitContentPartAccessibleName(candidate.element);
  }

  function isPrioritySemanticCandidate(candidate: ContentPartCandidate): boolean {
    return isSemanticContentPart(candidate.kind, candidate.role) ||
      (
        candidate.includeExplicitAccessibleName &&
        hasExplicitContentPartAccessibleName(candidate.element)
      );
  }

  function selectBoundedCandidates(
    source: ContentPartCandidate[],
  ): ContentPartCandidate[] {
    if (source.length <= MAX_CONTENT_PARTS) return source;
    const semanticCandidates = source.filter(isPrioritySemanticCandidate);
    const selected = new Set(
      semanticCandidates.slice(0, MAX_CONTENT_PARTS),
    );
    let remainingSlots = MAX_CONTENT_PARTS - selected.size;
    if (remainingSlots > 0) {
      for (const candidate of source) {
        if (remainingSlots <= 0) break;
        if (isPrioritySemanticCandidate(candidate)) continue;
        selected.add(candidate);
        remainingSlots -= 1;
      }
    }
    return source.filter((candidate) => selected.has(candidate));
  }

  function canCoalesceGenericText(
    left: ContentPartCandidate,
    right: ContentPartCandidate,
  ): boolean {
    return isGenericTextCandidate(left) &&
      isGenericTextCandidate(right) &&
      sharesInlineFlow(left.element, right.element);
  }

  function isGenericTextCandidate(candidate: ContentPartCandidate): boolean {
    return candidate.kind === "text" &&
      candidate.role === null &&
      !hasExplicitContentPartAccessibleName(candidate.element);
  }

  function hasExplicitContentPartAccessibleName(element: HTMLElement): boolean {
    return normalizeText(getExplicitContentPartAccessibleName(element)) !== null;
  }

  function sharesInlineFlow(left: HTMLElement, right: HTMLElement): boolean {
    if (left === right) return true;
    const leftAncestors = new Set<HTMLElement>();
    let current: HTMLElement | null = left;
    let remainingDepth = MAX_CONTENT_PART_NODES;
    while (current && remainingDepth > 0) {
      leftAncestors.add(current);
      if (current === root) break;
      current = current.parentElement;
      remainingDepth -= 1;
    }
    current = right;
    remainingDepth = MAX_CONTENT_PART_NODES;
    while (current && !leftAncestors.has(current) && remainingDepth > 0) {
      if (current === root) return false;
      current = current.parentElement;
      remainingDepth -= 1;
    }
    if (!current) return false;
    return hasInlinePath(left, current) && hasInlinePath(right, current);
  }

  function hasInlinePath(element: HTMLElement, ancestor: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current && current !== ancestor) {
      if (!isInlineFlowElement(current)) return false;
      current = current.parentElement;
    }
    return current === ancestor;
  }

  function isInlineFlowElement(element: HTMLElement): boolean {
    const cached = inlineFlowCache.get(element);
    if (cached !== undefined) return cached;
    const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
    const isInline = display === "contents" || display.startsWith("inline");
    inlineFlowCache.set(element, isInline);
    return isInline;
  }
}

function isSemanticContentPart(
  kind: UIAttachmentContentPart["kind"],
  role: string | null,
): boolean {
  return kind !== "text" || role !== null;
}

function shouldReserveStoredContentPartBytes(part: UIAttachmentContentPart): boolean {
  return isSemanticContentPart(part.kind, part.role) || part.accessibleName !== null;
}

function withReservedContentPartByteBudget(
  globalBudget: { remaining: number },
  laterSemanticCandidates: number,
  disclose: (localBudget: { remaining: number }) => void,
): void {
  const reservedBytes = Math.min(
    globalBudget.remaining,
    laterSemanticCandidates * MIN_RESERVED_SEMANTIC_CONTENT_PART_BYTES,
  );
  const availableBytes = globalBudget.remaining - reservedBytes;
  if (availableBytes <= 0) return;
  const localBudget = { remaining: availableBytes };
  disclose(localBudget);
  globalBudget.remaining -= availableBytes - localBudget.remaining;
}

function inferContentPartKind(
  element: HTMLElement,
  role: string | null,
): UIAttachmentContentPart["kind"] {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "time") return "time";
  if (tagName === "a" || role === "link") return "link";
  if (tagName === "button" || role === "button") return "button";
  if (tagName === "img" || role === "img") return "image";
  if (
    ["input", "textarea", "select"].includes(tagName) ||
    ["checkbox", "radio", "slider", "searchbox", "textbox", "combobox", "switch"].includes(
      role ?? "",
    )
  ) return "form_control";
  return "text";
}

function isContentPartHidden(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  return computed?.display === "none" || computed?.visibility === "hidden";
}

function deriveContentPartsDisclosure(
  parts: UIAttachmentContentPart[],
  audit: DisclosureAudit,
): UIAttachmentContentPart[] {
  const disclosedParts: UIAttachmentContentPart[] = [];
  const byteBudget = { remaining: MAX_CONTENT_PART_BYTES };
  const boundedParts = parts.slice(0, MAX_CONTENT_PARTS);
  let laterSemanticParts = boundedParts.filter(shouldReserveStoredContentPartBytes).length;
  for (const part of boundedParts) {
    if (byteBudget.remaining <= 0) break;
    if (shouldReserveStoredContentPartBytes(part)) laterSemanticParts -= 1;
    let text: string | null = null;
    let accessibleName: string | null = null;
    withReservedContentPartByteBudget(
      byteBudget,
      laterSemanticParts,
      (partByteBudget) => {
        text = takeBudgetedContentPartText(
          part.text,
          "element.text",
          audit,
          partByteBudget,
        );
        accessibleName = takeBudgetedContentPartText(
          part.accessibleName,
          "element.accessibleName",
          audit,
          partByteBudget,
        );
      },
    );
    if (!text && !accessibleName) continue;
    disclosedParts.push({
      ...part,
      tagName: redactDisclosureValue(part.tagName, "element.tagName", audit),
      role: redactText(part.role, "element.role", audit),
      text,
      accessibleName,
    });
  }
  return disclosedParts;
}

function takeBudgetedContentPartText(
  value: string | null,
  field: "element.text" | "element.accessibleName",
  audit: DisclosureAudit,
  byteBudget: { remaining: number },
): string | null {
  if (!value || byteBudget.remaining <= 0) return null;
  if (
    (
      value.length > MAX_PAGE_CONTROLLED_TEXT_CHARACTERS ||
      isTruncatedText(value)
    ) &&
    shouldRedactText(audit.disclosureMode)
  ) {
    markSensitiveField(audit, field, true);
    const boundedRedaction = limitTextToUtf8BytesWithMarker(
      "[redacted:declared-sensitive]",
      byteBudget.remaining,
    );
    const consumedBytes = utf8ByteLength(boundedRedaction);
    if (consumedBytes <= 0) return null;
    byteBudget.remaining -= consumedBytes;
    return boundedRedaction;
  }
  const normalized = normalizeText(value);
  if (!normalized) return null;

  // `normalizeText` applies a fixed, page-controlled input limit. Redact that complete
  // bounded value before applying the independently shrinking output byte budget.
  const disclosed = redactText(normalized, field, audit);
  if (!disclosed) return null;
  const bounded = limitTextToUtf8BytesWithMarker(disclosed, byteBudget.remaining);
  const consumedBytes = utf8ByteLength(bounded);
  if (consumedBytes <= 0) return null;
  byteBudget.remaining -= consumedBytes;
  return bounded;
}

function inferRole(element: HTMLElement): string | null {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === "button") return "button";
  if (tagName === "a" && element.hasAttribute("href")) return "link";
  if (/^h[1-6]$/.test(tagName)) return "heading";
  if (tagName === "input") return inferInputRole(element as HTMLInputElement);
  if (tagName === "textarea") return "textbox";
  if (tagName === "select") return "combobox";
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

function getAccessibleName(element: HTMLElement, audit: DisclosureAudit): AccessibleNameResult {
  const ariaLabel = redactText(
    element.getAttribute("aria-label"),
    "element.accessibleName",
    audit,
  );
  if (ariaLabel) return { value: ariaLabel, conciseRoleName: null };

  const labelledBy = limitPageControlledText(element.getAttribute("aria-labelledby"));
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .slice(0, MAX_ARIA_LABEL_REFERENCES)
      .map((id) => {
        const referenced = findIdReference(element, id);
        return referenced ? collectSelectedDomText(referenced) : "";
      })
      .join(" ");
    const normalized = redactText(text, "element.accessibleName", audit);
    if (normalized) return { value: normalized, conciseRoleName: null };
  }

  const formLabel = redactText(findFormLabel(element), "element.accessibleName", audit);
  if (formLabel) return { value: formLabel, conciseRoleName: null };

  const inputButtonValue = redactText(
    getInputButtonAccessibleName(element),
    "element.accessibleName",
    audit,
  );
  if (inputButtonValue) return { value: inputButtonValue, conciseRoleName: null };

  const textParts = collectAccessibleTextParts(element);
  const text = redactText(textParts.join(""), "element.accessibleName", audit);
  if (text) {
    return {
      value: text,
      conciseRoleName: deriveConciseRoleName(text, textParts),
    };
  }

  return {
    value: redactText(element.getAttribute("title"), "element.accessibleName", audit),
    conciseRoleName: null,
  };
}

function getInputButtonAccessibleName(element: HTMLElement): string | null {
  if (element.tagName.toLowerCase() !== "input") {
    return null;
  }
  const type = (limitPageControlledText(element.getAttribute("type")) ?? "text").toLowerCase();
  return ["button", "submit", "reset"].includes(type) ? element.getAttribute("value") : null;
}

function buildSelectorHints(element: HTMLElement, selectedText: string): string[] {
  const hints: string[] = [];
  const testId = limitLocatorValue(element.getAttribute("data-testid"));
  if (testId) hints.push(`[data-testid="${escapeAttribute(testId)}"]`);
  const id = limitLocatorValue(element.id);
  if (id) hints.push(`#${escapeCssIdentifier(id)}`);
  const stableDataSelector = buildUniqueStableDataSelector(element);
  if (stableDataSelector) hints.push(stableDataSelector);
  if (mayNeedDynamicRecovery(element, selectedText)) {
    const descendantAnchoredSelector = buildDescendantAnchoredSelector(element);
    if (descendantAnchoredSelector) hints.push(descendantAnchoredSelector);
    const ancestorAnchoredSelector = buildAncestorAnchoredSelector(element);
    if (ancestorAnchoredSelector) hints.push(ancestorAnchoredSelector);
  }

  const tagName = element.tagName.toLowerCase();
  const type = limitLocatorValue(element.getAttribute("type"));
  if (type) hints.push(`${tagName}[type="${escapeAttribute(type)}"]`);
  hints.push(tagName);
  const structuralSelector = buildUniqueStructuralSelector(element);
  if (structuralSelector) hints.push(structuralSelector);

  return [...new Set(hints)];
}

function mayNeedDynamicRecovery(element: HTMLElement, selectedText: string): boolean {
  if (/\d/.test([
    selectedText,
    limitPageControlledText(element.getAttribute("aria-label")) ?? "",
    limitPageControlledText(element.getAttribute("title")) ?? "",
  ].join(" "))) return true;
  return element.closest(
    "button, a[href], input, select, textarea, summary, " +
    "[role=button], [role=link], [role=checkbox], [role=radio], " +
    "[role=switch], [role=menuitem], [role=tab]",
  ) !== null;
}

function buildAncestorAnchoredSelector(element: HTMLElement): string | null {
  if (element.getRootNode() !== element.ownerDocument) return null;

  let ancestor = element.parentElement;
  for (let depth = 1; ancestor && depth <= MAX_ANCHORED_SELECTOR_DEPTH; depth += 1) {
    const anchorSelector = buildUniqueStableIdentitySelector(ancestor);
    if (anchorSelector) {
      const relativeSelector = buildRelativeStructuralSelector(ancestor, element);
      if (relativeSelector) {
        const selector = `${anchorSelector} > ${relativeSelector}`;
        if (isUniqueSelectorForElement(element, selector)) return selector;
      }
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function buildDescendantAnchoredSelector(element: HTMLElement): string | null {
  if (element.getRootNode() !== element.ownerDocument) return null;

  let container = element.parentElement;
  for (let depth = 1; container && depth <= MAX_ANCHORED_SELECTOR_DEPTH; depth += 1) {
    const containerBase = buildSemanticContainerSelector(container);
    if (containerBase) {
      const localTargetSelector = buildScopedTargetSelector(container, element);
      if (localTargetSelector) {
        const links = container.querySelectorAll<HTMLAnchorElement>("a[href]");
        const candidates: string[] = [];
        for (let index = 0; index < Math.min(links.length, MAX_ANCHOR_LINK_SCAN); index += 1) {
          const href = links[index]?.getAttribute("href");
          if (href && isSafeContentAnchorHref(href)) candidates.push(href);
        }
        candidates.sort((left, right) => {
          const leftStatus = /\/status\/\d+(?:\/|$)/.test(left) ? 0 : 1;
          const rightStatus = /\/status\/\d+(?:\/|$)/.test(right) ? 0 : 1;
          return leftStatus - rightStatus || left.length - right.length || left.localeCompare(right);
        });
        for (const href of [...new Set(candidates)]) {
          const containerSelector = `${containerBase}:has(a[href="${escapeAttribute(href)}"])`;
          if (!isUniqueSelectorForElement(container, containerSelector)) continue;
          const selector = `${containerSelector}${localTargetSelector.combinator}${localTargetSelector.value}`;
          if (isUniqueSelectorForElement(element, selector)) return selector;
        }
      }
    }
    container = container.parentElement;
  }
  return null;
}

function buildSemanticContainerSelector(element: HTMLElement): string | null {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "article") return "article";
  const role = limitLocatorValue(element.getAttribute("role"))?.toLowerCase();
  if (role === "article" || role === "listitem") {
    return `[role="${escapeAttribute(role)}"]`;
  }
  return tagName === "li" ? "li" : null;
}

function buildScopedTargetSelector(
  container: HTMLElement,
  element: HTMLElement,
): ScopedTargetSelector | null {
  const testId = limitLocatorValue(element.getAttribute("data-testid"));
  if (testId) {
    const selector = `[data-testid="${escapeAttribute(testId)}"]`;
    try {
      const matches = container.querySelectorAll(selector);
      if (matches.length === 1 && matches[0] === element) {
        return { value: selector, combinator: " " };
      }
    } catch {
      // Invalid page-controlled values are ignored.
    }
  }

  const stableDataSelector = buildScopedStableDataSelector(container, element);
  if (stableDataSelector) return { value: stableDataSelector, combinator: " " };

  const relativeSelector = buildRelativeStructuralSelector(container, element);
  return relativeSelector ? { value: relativeSelector, combinator: " > " } : null;
}

function buildScopedStableDataSelector(
  container: HTMLElement,
  element: HTMLElement,
): string | null {
  const attributeNames = collectStableDataAttributeNames(element);
  for (const name of attributeNames) {
    const selector = `[${name}]`;
    try {
      const matches = container.querySelectorAll(selector);
      if (matches.length === 1 && matches[0] === element) return selector;
    } catch {
      // Invalid page-controlled attribute names are ignored.
    }
  }
  return null;
}

function buildUniqueStableIdentitySelector(element: HTMLElement): string | null {
  const root = element.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return null;

  const id = limitLocatorValue(element.id);
  if (id) {
    const selector = `#${escapeCssIdentifier(id)}`;
    if (isUniqueSelectorForElement(element, selector)) return selector;
  }
  const testId = limitLocatorValue(element.getAttribute("data-testid"));
  if (testId) {
    const selector = `[data-testid="${escapeAttribute(testId)}"]`;
    if (isUniqueSelectorForElement(element, selector)) return selector;
  }
  return buildUniqueStableDataSelector(element);
}

function buildRelativeStructuralSelector(
  ancestor: HTMLElement,
  element: HTMLElement,
): string | null {
  const parts: string[] = [];
  const budget: StructuralSelectorBudget = {
    remainingSiblings: MAX_STRUCTURAL_SIBLING_SCAN,
  };
  let current: HTMLElement | null = element;
  for (let depth = 0; current && current !== ancestor && depth < MAX_ANCHORED_SELECTOR_DEPTH; depth += 1) {
    const segment = buildStructuralSelectorSegment(current, budget);
    if (!segment) return null;
    parts.unshift(segment);
    current = current.parentElement;
  }
  if (current !== ancestor || parts.length === 0) return null;
  const selector = parts.join(" > ");
  return selector.length <= MAX_STRUCTURAL_SELECTOR_LENGTH ? selector : null;
}

function isSafeContentAnchorHref(value: string): boolean {
  return value.length > 1 &&
    value.length <= MAX_ANCHOR_HREF_LENGTH &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[?#\s"\\]/.test(value);
}

function isUniqueSelectorForElement(element: HTMLElement, selector: string): boolean {
  if (selector.length > MAX_STRUCTURAL_SELECTOR_LENGTH) return false;
  const root = element.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return false;
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function buildUniqueStableDataSelector(element: HTMLElement): string | null {
  const root = element.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return null;
  const attributeNames = collectStableDataAttributeNames(element);
  for (const name of attributeNames) {
    const selector = `[${name}]`;
    try {
      const matches = root.querySelectorAll(selector);
      if (matches.length === 1 && matches[0] === element) return selector;
    } catch {
      // Invalid page-controlled attribute names are ignored.
    }
  }
  return null;
}

function collectStableDataAttributeNames(element: HTMLElement): string[] {
  const attributeNames: string[] = [];
  const count = Math.min(element.attributes.length, MAX_ELEMENT_ATTRIBUTES);
  for (let index = 0; index < count; index += 1) {
    const name = element.attributes[index]?.name.toLowerCase();
    if (
      name &&
      name !== "data-testid" &&
      !name.startsWith("data-ui-attach-") &&
      STABLE_DATA_ATTRIBUTE_NAME.test(name)
    ) {
      attributeNames.push(name);
    }
  }
  return attributeNames.sort();
}

function buildUniqueStructuralSelector(element: HTMLElement): string | null {
  if (element.getRootNode() !== element.ownerDocument) {
    return null;
  }

  const parts: string[] = [];
  const budget: StructuralSelectorBudget = {
    remainingSiblings: MAX_STRUCTURAL_SIBLING_SCAN,
  };
  let current: HTMLElement | null = element;
  for (let depth = 0; current && depth < MAX_STRUCTURAL_SELECTOR_DEPTH; depth += 1) {
    const segment = buildStructuralSelectorSegment(current, budget);
    if (segment === null) {
      return null;
    }
    parts.unshift(segment);
    const selector = parts.join(" > ");
    if (selector.length > MAX_STRUCTURAL_SELECTOR_LENGTH) {
      return null;
    }
    try {
      const matches = element.ownerDocument.querySelectorAll(selector);
      if (matches.length === 1 && matches[0] === element) {
        if (parts.length > 1 || selector.includes(":nth-of-type(")) {
          return selector;
        }
      }
    } catch {
      return null;
    }
    current = current.parentElement;
  }
  return null;
}

function buildStructuralSelectorSegment(
  element: HTMLElement,
  budget: StructuralSelectorBudget,
): string | null {
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) {
    return tagName;
  }

  let sameTagIndex = 1;
  for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (budget.remainingSiblings <= 0) {
      return null;
    }
    budget.remainingSiblings -= 1;
    if (sibling.tagName === element.tagName) {
      sameTagIndex += 1;
    }
  }

  let hasFollowingSameTag = false;
  for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    if (budget.remainingSiblings <= 0) {
      return null;
    }
    budget.remainingSiblings -= 1;
    if (sibling.tagName === element.tagName) {
      hasFollowingSameTag = true;
      break;
    }
  }
  if (sameTagIndex === 1 && !hasFollowingSameTag) {
    return tagName;
  }
  return `${tagName}:nth-of-type(${sameTagIndex})`;
}

function collectNearbyText(element: HTMLElement, audit: DisclosureAudit): string[] {
  const nearbyText: string[] = [];
  const budget = createAccessibleTextBudget();
  let current: HTMLElement | null = element;

  for (
    let depth = 0;
    depth < 3 && nearbyText.length < 5 && hasAccessibleTextBudget(budget);
    depth += 1
  ) {
    if (!current) {
      break;
    }

    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      break;
    }

    for (
      let index = 0;
      index < parent.children.length && hasAccessibleTextBudget(budget);
      index += 1
    ) {
      budget.remainingNodes -= 1;
      const child = parent.children[index];
      if (!(child instanceof HTMLElement)) {
        continue;
      }
      if (child === current) {
        continue;
      }

      const text = redactText(
        collectAccessibleText(child, budget, true),
        "context.nearbyText",
        audit,
      );
      if (text && !nearbyText.includes(text)) {
        nearbyText.push(text);
      }

      if (nearbyText.length >= 5) {
        break;
      }
    }

    current = parent;
  }

  return nearbyText;
}

function createAccessibleTextBudget(): AccessibleTextBudget {
  return {
    remainingNodes: MAX_ACCESSIBLE_TEXT_NODES,
    remainingCharacters: MAX_ACCESSIBLE_TEXT_CHARACTERS,
    remainingSlotScanNodes: MAX_ACCESSIBLE_SLOT_SCAN_NODES,
    slotAssignmentIndexes: new WeakMap(),
  };
}

function hasAccessibleTextBudget(budget: AccessibleTextBudget): boolean {
  return budget.remainingNodes > 0 && budget.remainingCharacters > 0;
}

function collectAccessibleText(
  root: HTMLElement,
  budget = createAccessibleTextBudget(),
  rootAlreadyReserved = false,
): string {
  return collectAccessibleTextParts(root, budget, rootAlreadyReserved).join("");
}

function collectAccessibleTextParts(
  root: HTMLElement,
  budget = createAccessibleTextBudget(),
  rootAlreadyReserved = false,
): string[] {
  if (!rootAlreadyReserved) {
    if (!hasAccessibleTextBudget(budget)) {
      return [];
    }
    budget.remainingNodes -= 1;
  }

  const textParts: string[] = [];
  visitAccessibleTextNode(root, 0, budget, textParts);

  return textParts;
}

function visitAccessibleTextNode(
  node: Node,
  depth: number,
  budget: AccessibleTextBudget,
  textParts: string[],
): void {
  if (budget.remainingCharacters <= 0) {
    return;
  }

  if (node.nodeType === node.TEXT_NODE) {
    const value = node.textContent ?? "";
    if (value.length > 0) {
      const part = value.slice(0, budget.remainingCharacters);
      textParts.push(part);
      budget.remainingCharacters -= part.length;
    }
    return;
  }

  if (node instanceof HTMLElement) {
    if (ACCESSIBLE_TEXT_SKIPPED_TAGS.has(node.tagName.toLowerCase())) {
      return;
    }
    const computed = node.ownerDocument.defaultView?.getComputedStyle(node) ??
      getComputedStyle(node);
    if (
      node.hidden ||
      node.getAttribute("aria-hidden") === "true" ||
      computed.display === "none" ||
      computed.visibility === "hidden" ||
      computed.visibility === "collapse"
    ) {
      return;
    }
  }

  if (depth >= MAX_ACCESSIBLE_TEXT_DEPTH || budget.remainingNodes <= 0) {
    return;
  }

  if (node instanceof HTMLSlotElement) {
    const assignmentStatus = visitAssignedSlotNodes(
      node,
      depth + 1,
      budget,
      textParts,
    );
    if (assignmentStatus !== "none" || budget.remainingNodes <= 0) {
      return;
    }
  }

  let children: ArrayLike<Node> = node.childNodes;
  if (node instanceof HTMLElement && node.shadowRoot) {
    children = node.shadowRoot.childNodes;
  }

  for (
    let index = 0;
    index < children.length && hasAccessibleTextBudget(budget);
    index += 1
  ) {
    budget.remainingNodes -= 1;
    const child = children[index];
    if (child) {
      visitAccessibleTextNode(child, depth + 1, budget, textParts);
    }
  }
}

function visitAssignedSlotNodes(
  slot: HTMLSlotElement,
  depth: number,
  budget: AccessibleTextBudget,
  textParts: string[],
): "assigned" | "none" | "unknown" {
  const root = slot.getRootNode();
  if (!(root instanceof ShadowRoot)) {
    return "none";
  }

  const assignmentIndex = getSlotAssignmentIndex(root, budget);
  const assignedNodes = assignmentIndex.assignments.get(slot);
  if (!assignedNodes || assignedNodes.length === 0) {
    return assignmentIndex.complete ? "none" : "unknown";
  }

  for (
    let index = 0;
    index < assignedNodes.length && hasAccessibleTextBudget(budget);
    index += 1
  ) {
    budget.remainingNodes -= 1;
    const child = assignedNodes[index];
    if (child) {
      visitAccessibleTextNode(child, depth, budget, textParts);
    }
  }

  return "assigned";
}

function getSlotAssignmentIndex(
  root: ShadowRoot,
  budget: AccessibleTextBudget,
): SlotAssignmentIndex {
  const cached = budget.slotAssignmentIndexes.get(root);
  if (cached) {
    return cached;
  }

  const assignments = new Map<HTMLSlotElement, Node[]>();
  const hostChildren = root.host.childNodes;
  let index = 0;
  while (index < hostChildren.length && budget.remainingSlotScanNodes > 0) {
    budget.remainingSlotScanNodes -= 1;
    const child = hostChildren[index];
    const assignedSlot = child ? getAssignedSlot(child) : null;
    if (child && assignedSlot) {
      const assignedNodes = assignments.get(assignedSlot) ?? [];
      assignedNodes.push(child);
      assignments.set(assignedSlot, assignedNodes);
    }
    index += 1;
  }

  const assignmentIndex = {
    assignments,
    complete: index >= hostChildren.length,
  };
  budget.slotAssignmentIndexes.set(root, assignmentIndex);
  return assignmentIndex;
}

function getAssignedSlot(node: Node): HTMLSlotElement | null {
  if (node.nodeType === node.ELEMENT_NODE) {
    return (node as Element).assignedSlot;
  }
  if (node.nodeType === node.TEXT_NODE) {
    return (node as Text).assignedSlot;
  }
  return null;
}

function summarizeParent(element: HTMLElement, audit: DisclosureAudit): string | null {
  const parent = element.parentElement;
  if (!parent) return null;
  const role = limitPageControlledText(parent.getAttribute("role"));
  const label = limitPageControlledText(parent.getAttribute("aria-label"));
  const tag = parent.tagName.toLowerCase();
  return redactText(
    [tag, role, label].filter(Boolean).join(" "),
    "context.parentSummary",
    audit,
  );
}

function isVisible(element: HTMLElement, rect: DOMRect, computed: CSSStyleDeclaration): boolean {
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current) {
    const style = current === element
      ? computed
      : (current.ownerDocument.defaultView?.getComputedStyle(current) ??
        getComputedStyle(current));
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      (style.opacity !== "" && Number(style.opacity) === 0) ||
      current.hidden
    ) {
      return false;
    }
    current = getComposedParentElement(current);
  }
  return true;
}

function getComposedParentElement(element: HTMLElement): HTMLElement | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const host = (element.getRootNode() as ShadowRoot).host;
  return host?.namespaceURI === "http://www.w3.org/1999/xhtml"
    ? (host as HTMLElement)
    : null;
}

function buildIdSeed(element: HTMLElement, selectedText: string): string {
  return (
    limitLocatorValue(element.getAttribute("data-testid")) ??
    limitLocatorValue(element.id) ??
    normalizeText(limitTextWithMarker(selectedText, MAX_ATTACHMENT_ID_TEXT_SEED_CHARACTERS)) ??
    element.tagName.toLowerCase()
  );
}

function normalizeText(value: string | null): string | null {
  const bounded = limitPageControlledText(value);
  const normalized = bounded?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function collectSelectedDomText(root: Node): string {
  const parts: string[] = [];
  const ownerDocument = root.ownerDocument;
  if (!ownerDocument) return "";
  const showAll = ownerDocument.defaultView?.NodeFilter.SHOW_ALL ?? 0xffffffff;
  const walker = ownerDocument.createTreeWalker(root, showAll);
  let remainingCharacters = MAX_PAGE_CONTROLLED_TEXT_CHARACTERS + 1;
  let remainingNodes = MAX_SELECTED_DOM_TEXT_NODES;
  let truncated = false;

  while (remainingNodes > 0 && remainingCharacters > 0) {
    const child = walker.nextNode();
    if (!child) break;
    remainingNodes -= 1;

    if (child.nodeType === child.TEXT_NODE || child.nodeType === child.CDATA_SECTION_NODE) {
      const value = child.nodeValue ?? "";
      const part = value.slice(0, remainingCharacters);
      parts.push(part);
      remainingCharacters -= part.length;
      if (part.length < value.length) truncated = true;
    }
  }

  if (remainingNodes === 0 && !truncated) {
    truncated = walker.nextNode() !== null;
  }
  if (remainingCharacters === 0) truncated = true;

  const value = parts.join("");
  return truncated || value.length > MAX_PAGE_CONTROLLED_TEXT_CHARACTERS
    ? markTextTruncated(value, MAX_PAGE_CONTROLLED_TEXT_CHARACTERS)
    : value;
}

function limitPageControlledText(value: string | null): string | null {
  return value === null
    ? null
    : limitTextWithMarker(value, MAX_PAGE_CONTROLLED_TEXT_CHARACTERS);
}

function limitLocatorValue(value: string | null): string | null {
  return value !== null && value.length > 0 && value.length <= MAX_PAGE_CONTROLLED_TEXT_CHARACTERS
    ? value
    : null;
}

function limitTextWithMarker(value: string, maxCharacters: number): string {
  return value.length > maxCharacters ? markTextTruncated(value, maxCharacters) : value;
}

function limitTextToUtf8BytesWithMarker(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const markerBytes = utf8ByteLength(TRUNCATION_MARKER);
  const contentBytes = Math.max(0, maxBytes - markerBytes);
  let consumedBytes = 0;
  let markedEnd = 0;
  for (const character of value) {
    const characterBytes = utf8CodePointByteLength(character.codePointAt(0) ?? 0);
    if (consumedBytes + characterBytes > maxBytes) {
      return markerBytes <= maxBytes
        ? `${value.slice(0, markedEnd)}${TRUNCATION_MARKER}`
        : TRUNCATION_MARKER.slice(0, maxBytes);
    }
    consumedBytes += characterBytes;
    if (consumedBytes <= contentBytes) markedEnd += character.length;
  }
  return value;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    bytes += utf8CodePointByteLength(character.codePointAt(0) ?? 0);
  }
  return bytes;
}

function utf8CodePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function markTextTruncated(value: string, maxCharacters: number): string {
  const marker = TRUNCATION_MARKER.slice(0, maxCharacters);
  return `${value.slice(0, Math.max(0, maxCharacters - marker.length))}${marker}`;
}

function isTruncatedText(value: string): boolean {
  return value.endsWith(TRUNCATION_MARKER);
}

function redactText(
  value: string | null,
  field: string,
  audit: DisclosureAudit,
): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const redacted = redactRecognizedSensitiveText(normalized);
  if (redacted !== normalized) {
    markSensitiveField(audit, field, shouldRedactText(audit.disclosureMode));
  }

  return shouldRedactText(audit.disclosureMode) ? redacted : normalized;
}

function sanitizeSourceUrl(
  value: string | null,
  audit: DisclosureAudit,
): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    if (url.username || url.password) {
      const redactUserInfo = shouldRedactText(audit.disclosureMode);
      markSensitiveField(audit, "source.url", redactUserInfo);
      if (redactUserInfo) {
        url.username = "";
        url.password = "";
      }
    }
    if (shouldRedactText(audit.disclosureMode)) {
      const sanitizedPathname = redactEmbeddedUrlUserInfo(url.pathname, audit);
      if (sanitizedPathname !== url.pathname) {
        url.pathname = sanitizedPathname;
      }
    }
    if (url.search && shouldRedactText(audit.disclosureMode)) {
      const rawSearch = url.search.slice(1);
      if (hasAmbiguousRawQueryUserInfo(rawSearch)) {
        markSensitiveField(audit, "source.url", true);
        url.search = "?[redacted:url]";
      } else {
        const sanitizedSearch = rawSearch
          .split("&")
          .map((part) => {
            const separator = part.indexOf("=");
            if (separator < 0) {
              return redactEmbeddedUrlUserInfo(part, audit);
            }
            const key = redactEmbeddedUrlUserInfo(part.slice(0, separator), audit);
            const entryValue = redactEmbeddedUrlUserInfo(part.slice(separator + 1), audit);
            return `${key}=${entryValue}`;
          })
          .join("&");
        if (sanitizedSearch !== rawSearch) {
          url.search = `?${sanitizedSearch}`;
        }
      }
    }
    if (url.hash && shouldRedactText(audit.disclosureMode)) {
      const hashValue = url.hash.slice(1);
      const sanitizedHash = redactHashEmbeddedUrlUserInfo(hashValue, audit);
      if (sanitizedHash !== hashValue) {
        url.hash = sanitizedHash;
      }
    }
    if (url.search || url.hash) {
      markSensitiveField(audit, "source.url", shouldRedactUrl(audit.disclosureMode));
    }

    if (shouldRedactUrl(audit.disclosureMode)) {
      url.search = "";
      url.hash = "";
    }

    return deriveSourceUrlTextDisclosure(url.toString(), audit);
  } catch {
    const stripped = normalized.split(/[?#]/)[0] ?? "";
    if (stripped !== normalized) {
      markSensitiveField(audit, "source.url", shouldRedactUrl(audit.disclosureMode));
    }

    const fallback = shouldRedactUrl(audit.disclosureMode) ? stripped : normalized;
    if (!fallback) {
      return null;
    }
    const redacted = redactUrlUserInfoInText(fallback);
    if (redacted !== fallback) {
      markSensitiveField(audit, "source.url", shouldRedactText(audit.disclosureMode));
    }
    return deriveSourceUrlTextDisclosure(
      shouldRedactText(audit.disclosureMode) ? redacted : fallback,
      audit,
    );
  }
}

function findIdReference(element: HTMLElement, id: string): Element | null {
  const elementRoot = element.getRootNode() as Node & {
    getElementById?: (value: string) => Element | null;
  };
  return elementRoot.getElementById?.(id) ?? element.ownerDocument.getElementById(id);
}

function redactEmbeddedUrlUserInfo(
  value: string,
  audit: DisclosureAudit,
  failClosedOnAmbiguousHashBoundary = false,
): string {
  const redacted = redactUrlUserInfoInText(value, failClosedOnAmbiguousHashBoundary);
  if (redacted !== value) {
    markSensitiveField(audit, "source.url", true);
  }
  return redacted;
}

function redactUrlUserInfoInText(
  value: string,
  failClosedOnAmbiguousHashBoundary = false,
): string {
  const decoded = decodePercentEscapesWithSpans(value);
  const urlStarts = findDecodedUrlStarts(decoded.text);
  if (urlStarts.length > MAX_EMBEDDED_URL_STARTS) {
    return "[redacted:url]";
  }
  if (hasAnyAmbiguousEncodedNumericAuthority(decoded, urlStarts)) {
    return "[redacted:url]";
  }
  for (let index = 0; index + 1 < urlStarts.length; index += 1) {
    const authorityStart = urlStarts[index].index + urlStarts[index][0].length;
    const urlStartWasEncoded = decoded.spans
      .slice(urlStarts[index].index, authorityStart)
      .some((span) => span.encoded);
    const nextUrlStart = urlStarts[index + 1].index;
    const prefixAuthorityEnd = findDecodedAuthorityEnd(
      decoded,
      authorityStart,
      nextUrlStart,
      urlStartWasEncoded,
    );
    const laterAt = decoded.text.indexOf(
      "@",
      nextUrlStart + urlStarts[index + 1][0].length,
    );
    if (prefixAuthorityEnd === nextUrlStart && laterAt >= 0) {
      return "[redacted:url]";
    }
  }
  const decodedRemovals: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < urlStarts.length; index += 1) {
    const urlStart = urlStarts[index];
    const authorityStart = urlStart.index + urlStart[0].length;
    const urlStartWasEncoded = decoded.spans
      .slice(urlStart.index, authorityStart)
      .some((span) => span.encoded);
    const candidateEnd = urlStarts[index + 1]?.index ?? decoded.text.length;
    const authorityEnd = findDecodedAuthorityEnd(
      decoded,
      authorityStart,
      candidateEnd,
      urlStartWasEncoded,
    );
    const userInfoEnd = decoded.text.lastIndexOf("@", authorityEnd - 1);
    if (userInfoEnd >= authorityStart) {
      if (
        failClosedOnAmbiguousHashBoundary &&
        hasAmbiguousHashParameterBoundary(decoded, authorityStart, userInfoEnd)
      ) {
        return "[redacted:url]";
      }
      decodedRemovals.push({ start: authorityStart, end: userInfoEnd + 1 });
    }
  }

  if (decodedRemovals.length === 0) {
    return value;
  }

  const removals = mergeRemovalRanges(
    decodedRemovals.map((removal) => ({
      start: decoded.spans[removal.start].start,
      end: decoded.spans[removal.end - 1].end,
    })),
  );
  let result = "";
  let cursor = 0;
  for (const removal of removals) {
    result += value.slice(cursor, removal.start);
    cursor = removal.end;
  }
  return result + value.slice(cursor);
}

function redactHashEmbeddedUrlUserInfo(value: string, audit: DisclosureAudit): string {
  return redactEmbeddedUrlUserInfo(value, audit, true);
}

function hasAmbiguousRawQueryUserInfo(value: string): boolean {
  const decoded = decodePercentEscapesWithSpans(value);
  const urlStarts = findDecodedUrlStarts(decoded.text);
  return hasPotentialCredentialAcrossRawQueryBoundary(decoded, urlStarts);
}

function hasAnyAmbiguousEncodedNumericAuthority(
  decoded: ReturnType<typeof decodePercentEscapesWithSpans>,
  urlStarts: RegExpExecArray[],
): boolean {
  for (const urlStart of urlStarts) {
    const authorityStart = urlStart.index + urlStart[0].length;
    const urlStartWasEncoded = decoded.spans
      .slice(urlStart.index, authorityStart)
      .some((span) => span.encoded);
    if (
      hasAmbiguousEncodedNumericAuthority(
        decoded,
        authorityStart,
        decoded.text.length,
        urlStartWasEncoded,
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasPotentialCredentialAcrossRawQueryBoundary(
  decoded: ReturnType<typeof decodePercentEscapesWithSpans>,
  urlStarts: RegExpExecArray[],
): boolean {
  for (const urlStart of urlStarts) {
    const authorityStart = urlStart.index + urlStart[0].length;
    let queryBoundary = -1;
    for (let cursor = authorityStart; cursor < decoded.text.length; cursor += 1) {
      if (decoded.text[cursor] === "&" && !decoded.spans[cursor].encoded) {
        queryBoundary = cursor;
        break;
      }
    }
    if (queryBoundary < 0) {
      continue;
    }
    const authorityEnd = findFirstDecodedStructuralEnd(decoded, authorityStart, queryBoundary);
    const localUserInfoEnd = decoded.text.lastIndexOf("@", authorityEnd - 1);
    if (
      authorityEnd < queryBoundary &&
      !decoded.spans[authorityEnd].encoded &&
      localUserInfoEnd >= authorityStart &&
      isValidAuthorityHost(decoded.text.slice(localUserInfoEnd + 1, authorityEnd))
    ) {
      continue;
    }
    if (
      !isPotentialRawQueryCredentialPrefix(
        decoded.text.slice(authorityStart, authorityEnd),
        authorityEnd === queryBoundary,
      )
    ) {
      continue;
    }
    if (decoded.text.indexOf("@", queryBoundary + 1) >= 0) {
      return true;
    }
  }
  return false;
}

function findFirstDecodedStructuralEnd(
  decoded: ReturnType<typeof decodePercentEscapesWithSpans>,
  authorityStart: number,
  candidateEnd: number,
): number {
  for (let cursor = authorityStart; cursor < candidateEnd; cursor += 1) {
    if (/[\s\\/?#]/.test(decoded.text[cursor])) {
      return cursor;
    }
  }
  return candidateEnd;
}

function isPotentialRawQueryCredentialPrefix(
  value: string,
  authorityReachesBoundary: boolean,
): boolean {
  if (authorityReachesBoundary) {
    return value.length > 0;
  }
  if (
    (value.startsWith("[") && isValidBracketedHost(value)) ||
    /^[A-Za-z]:$/u.test(value)
  ) {
    return false;
  }
  return value.includes(":");
}

function isValidAuthorityHost(value: string): boolean {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(`http://${value}/`);
    return parsed.username === "" && parsed.password === "" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

function findDecodedUrlStarts(value: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  for (const match of value.matchAll(
    /(?<![A-Za-z0-9+.-])(?:https?|wss?|ftp|file):[\\/]*|[\\/]{2}(?![\\/])/gi,
  )) {
    matches.push(match);
    if (matches.length > MAX_EMBEDDED_URL_STARTS) break;
  }
  return matches;
}

function hasAmbiguousHashParameterBoundary(
  decoded: ReturnType<typeof decodePercentEscapesWithSpans>,
  authorityStart: number,
  userInfoEnd: number,
): boolean {
  let parameterKeyLength = -1;
  for (let index = authorityStart; index < userInfoEnd; index += 1) {
    const isRawDelimiter = !decoded.spans[index].encoded;
    if (decoded.text[index] === "&" && isRawDelimiter) {
      parameterKeyLength = 0;
      continue;
    }
    if (parameterKeyLength < 0) {
      continue;
    }
    if (decoded.text[index] === "=" && isRawDelimiter) {
      if (parameterKeyLength > 0) {
        return true;
      }
      parameterKeyLength = -1;
      continue;
    }
    parameterKeyLength += 1;
  }
  return false;
}

function findDecodedAuthorityEnd(
  decoded: ReturnType<typeof decodePercentEscapesWithSpans>,
  authorityStart: number,
  candidateEnd: number,
  urlStartWasEncoded: boolean,
): number {
  let rawAuthorityEnd = candidateEnd;
  for (let cursor = authorityStart; cursor < candidateEnd; cursor += 1) {
    if (/[\s\\/?#]/.test(decoded.text[cursor]) && !decoded.spans[cursor].encoded) {
      rawAuthorityEnd = cursor;
      break;
    }
  }
  if (!urlStartWasEncoded) {
    return rawAuthorityEnd;
  }

  let firstStructuralEnd = rawAuthorityEnd;
  for (let cursor = authorityStart; cursor < rawAuthorityEnd; cursor += 1) {
    if (/[\s\\/?#]/.test(decoded.text[cursor])) {
      firstStructuralEnd = cursor;
      break;
    }
  }
  const userInfoEnd = decoded.text.lastIndexOf("@", rawAuthorityEnd - 1);
  if (userInfoEnd < authorityStart) {
    return firstStructuralEnd;
  }
  if (
    userInfoEnd > firstStructuralEnd &&
    !looksLikeEncodedCredentialPrefix(
      decoded.text.slice(authorityStart, firstStructuralEnd),
    )
  ) {
    return firstStructuralEnd;
  }

  const structuralScanStart = userInfoEnd + 1;
  for (let cursor = structuralScanStart; cursor < rawAuthorityEnd; cursor += 1) {
    if (/[\s\\/?#]/.test(decoded.text[cursor])) {
      return cursor;
    }
  }
  return rawAuthorityEnd;
}

function hasAmbiguousEncodedNumericAuthority(
  decoded: ReturnType<typeof decodePercentEscapesWithSpans>,
  authorityStart: number,
  candidateEnd: number,
  urlStartWasEncoded: boolean,
): boolean {
  if (!urlStartWasEncoded) {
    return false;
  }
  let rawAuthorityEnd = candidateEnd;
  let firstStructuralEnd = candidateEnd;
  for (let cursor = authorityStart; cursor < candidateEnd; cursor += 1) {
    if (!/[\s\\/?#]/.test(decoded.text[cursor])) {
      continue;
    }
    if (firstStructuralEnd === candidateEnd) {
      firstStructuralEnd = cursor;
    }
    if (!decoded.spans[cursor].encoded) {
      rawAuthorityEnd = cursor;
      break;
    }
  }
  const userInfoEnd = decoded.text.lastIndexOf("@", rawAuthorityEnd - 1);
  if (firstStructuralEnd >= userInfoEnd) {
    return false;
  }
  const prefix = decoded.text.slice(authorityStart, firstStructuralEnd);
  if (prefix.startsWith("[") || /^[A-Za-z]:$/u.test(prefix)) {
    return false;
  }
  const separator = prefix.indexOf(":");
  return separator > 0 && /^\d+$/u.test(prefix.slice(separator + 1));
}

function looksLikeEncodedCredentialPrefix(value: string): boolean {
  if (value.startsWith("[")) {
    return !isValidBracketedHost(value);
  }
  if (/^[A-Za-z]:$/u.test(value)) {
    return false;
  }
  const separator = value.indexOf(":");
  return separator === 0 || (separator > 0 && !/^\d+$/u.test(value.slice(separator + 1)));
}

function isValidBracketedHost(value: string): boolean {
  if (!value.startsWith("[")) {
    return false;
  }
  try {
    const parsed = new URL(`http://${value}/`);
    return parsed.username === "" && parsed.password === "" && parsed.hostname.startsWith("[");
  } catch {
    return false;
  }
}

function decodePercentEscapesWithSpans(value: string): {
  text: string;
  spans: Array<{ start: number; end: number; encoded: boolean }>;
} {
  let text = "";
  const spans: Array<{ start: number; end: number; encoded: boolean }> = [];
  for (let index = 0; index < value.length;) {
    const escape = value.slice(index, index + 3);
    if (/^%[0-9A-F]{2}$/i.test(escape)) {
      text += String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      spans.push({ start: index, end: index + 3, encoded: true });
      index += 3;
      continue;
    }
    text += value[index];
    spans.push({ start: index, end: index + 1, encoded: false });
    index += 1;
  }
  return { text, spans };
}

function mergeRemovalRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function deriveSourceUrlTextDisclosure(value: string, audit: DisclosureAudit): string {
  const redacted = redactRecognizedSensitiveTextInternal(value, false);
  if (redacted !== value) {
    markSensitiveField(audit, "source.url", shouldRedactText(audit.disclosureMode));
  }
  return shouldRedactText(audit.disclosureMode) ? redacted : value;
}

function buildLocatorBundle(
  element: HTMLElement,
  elementInfo: UIAttachmentElement,
  selectorHints: string[],
  conciseRoleName: string | null,
): UIAttachmentLocatorBundle {
  const candidates: UIAttachmentLocator[] = [];
  const accessibleName = elementInfo.accessibleName;
  const text = elementInfo.text;
  const testId = limitLocatorValue(element.getAttribute("data-testid"));

  if (elementInfo.role && accessibleName && !isTruncatedText(accessibleName)) {
    if (conciseRoleName) {
      candidates.push({
        strategy: "playwright.role",
        value: `page.getByRole(${quoteLocatorString(elementInfo.role)}, { name: ${quoteLocatorString(
          conciseRoleName,
        )} })`,
        confidence: 0.92,
        notes: "concise accessible name",
      });
    }
    candidates.push({
      strategy: "playwright.role",
      value: `page.getByRole(${quoteLocatorString(elementInfo.role)}, { name: ${quoteLocatorString(
        accessibleName,
      )} })`,
      confidence: 0.92,
    });
  }

  const label = findFormLabel(element);
  if (label && !isTruncatedText(label)) {
    candidates.push({
      strategy: "playwright.label",
      value: `page.getByLabel(${quoteLocatorString(label)})`,
      confidence: 0.88,
    });
  }

  if (testId) {
    candidates.push({
      strategy: "playwright.testId",
      value: `page.getByTestId(${quoteLocatorString(testId)})`,
      confidence: 0.86,
    });
  }

  const placeholder = limitLocatorValue(element.getAttribute("placeholder"));
  if (placeholder) {
    candidates.push({
      strategy: "playwright.placeholder",
      value: `page.getByPlaceholder(${quoteLocatorString(placeholder)})`,
      confidence: 0.82,
    });
  }

  const altText = limitLocatorValue(element.getAttribute("alt"));
  if (altText) {
    candidates.push({
      strategy: "playwright.altText",
      value: `page.getByAltText(${quoteLocatorString(altText)})`,
      confidence: 0.8,
    });
  }

  const title = limitLocatorValue(element.getAttribute("title"));
  if (title) {
    candidates.push({
      strategy: "playwright.title",
      value: `page.getByTitle(${quoteLocatorString(title)})`,
      confidence: 0.78,
    });
  }

  if (text && !isTruncatedText(text)) {
    candidates.push({
      strategy: "playwright.text",
      value: `page.getByText(${quoteLocatorString(text)})`,
      confidence: 0.74,
    });
  }

  const cssSelector = selectorHints.find(
    (selector) =>
      (selector.startsWith("[") || selector.startsWith("#")) &&
      !isAnchoredSelector(selector),
  );
  if (cssSelector) {
    candidates.push({
      strategy: "css",
      value: cssSelector,
      confidence: 0.68,
      notes: isStableDataAttributeSelector(cssSelector)
        ? "stable data attribute"
        : "engineering fallback",
    });
  }

  const anchoredSelector = selectorHints.find(isAnchoredSelector);
  if (anchoredSelector) {
    candidates.push({
      strategy: "css",
      value: anchoredSelector,
      confidence: anchoredSelector.includes(":has(") ? 0.64 : 0.62,
      notes: anchoredSelector.includes(":has(")
        ? "descendant anchored fallback"
        : "anchored structural fallback",
    });
  }

  const structuralSelector = selectorHints.find(
    (selector) =>
      !isAnchoredSelector(selector) &&
      (selector.includes(" > ") || selector.includes(":nth-of-type(")),
  );
  if (structuralSelector && structuralSelector !== cssSelector) {
    candidates.push({
      strategy: "css",
      value: structuralSelector,
      confidence: 0.55,
      notes: "structural fallback",
    });
  }

  candidates.push({
    strategy: "coordinates",
    value: `${elementInfo.bbox.x},${elementInfo.bbox.y},${elementInfo.bbox.width},${elementInfo.bbox.height}`,
    confidence: 0.2,
    notes: "last resort fallback",
  });

  const replayBoundedCandidates = candidates.filter(
    (candidate) =>
      candidate.strategy === "coordinates" ||
      candidate.value.length <= UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS,
  );
  const dedupedCandidates = dedupeLocators(replayBoundedCandidates);
  const primary = dedupedCandidates[0] ?? null;

  return {
    primary,
    candidates: dedupedCandidates,
    stability: {
      score: scoreLocatorStability(primary, dedupedCandidates),
      uniqueness: null,
      replayVerified: false,
      failureReason: null,
    },
  };
}

function isStableDataAttributeSelector(value: string): boolean {
  return /^\[data-[a-z0-9]+(?:-[a-z0-9]+)+\]$/.test(value);
}

function isAnchoredSelector(value: string): boolean {
  return value.includes(":has(") ||
    ((value.startsWith("[") || value.startsWith("#")) && value.includes(" > "));
}

function deriveConciseRoleName(
  accessibleName: string,
  textParts: string[],
): string | null {
  if (accessibleName.length <= MAX_CONCISE_ROLE_NAME_CHARACTERS) {
    return null;
  }

  for (const part of textParts) {
    const normalized = normalizeText(part);
    if (
      normalized &&
      normalized.length >= MIN_CONCISE_ROLE_NAME_CHARACTERS &&
      normalized.length <= MAX_CONCISE_ROLE_NAME_CHARACTERS &&
      normalized.length < accessibleName.length &&
      accessibleName.includes(normalized)
    ) {
      return normalized;
    }
  }

  return null;
}

function buildPolicy(audit: DisclosureAudit): UIAttachmentPolicy {
  return {
    disclosureMode: audit.disclosureMode,
    redactionLevel: getRedactionLevel(audit.disclosureMode),
    actionMode: "suggest_patch",
    allowScreenshot: false,
    allowDomSnippet: false,
    allowNetworkSend: false,
    allowedDomains: [],
    redactedFields: [...audit.redactedFields].sort(),
    sensitiveHints: [...audit.sensitiveHints].sort(),
    includedSensitiveFields: [...audit.includedSensitiveFields].sort(),
  };
}

function deriveLocatorBundleDisclosure(
  locatorBundle: UIAttachmentLocatorBundle,
  audit: DisclosureAudit,
): UIAttachmentLocatorBundle {
  return {
    ...locatorBundle,
    primary: locatorBundle.primary
      ? deriveLocatorDisclosure(locatorBundle.primary, audit)
      : null,
    candidates: locatorBundle.candidates.map((locator) =>
      deriveLocatorDisclosure(locator, audit),
    ),
    stability: {
      ...locatorBundle.stability,
      failureReason: redactText(
        locatorBundle.stability.failureReason,
        "locatorBundle.stability.failureReason",
        audit,
      ),
      verifiedValue: redactOptionalDisclosureValue(
        locatorBundle.stability.verifiedValue,
        "locatorBundle.stability.verifiedValue",
        audit,
      ),
    },
  };
}

function deriveLocatorDisclosure(
  locator: UIAttachmentLocator,
  audit: DisclosureAudit,
): UIAttachmentLocator {
  const redactedValue = locator.strategy === "css"
    ? deriveCssSelectorDisclosure(locator.value, "locatorBundle.candidates", audit)
    : redactLocatorValue(locator.value, audit);
  const redactedNotes = redactOptionalDisclosureValue(
    locator.notes,
    "locatorBundle.notes",
    audit,
  );
  return redactedValue === locator.value && redactedNotes === locator.notes
    ? locator
    : { ...locator, value: redactedValue, notes: redactedNotes ?? undefined };
}

function redactLocatorValue(value: string, audit: DisclosureAudit): string {
  return redactDisclosureValue(value, "locatorBundle.candidates", audit);
}

function deriveSelectorHintsDisclosure(
  values: string[],
  field: string,
  audit: DisclosureAudit,
): string[] {
  return values.map((value) => deriveCssSelectorDisclosure(value, field, audit));
}

function deriveCssSelectorDisclosure(
  value: string,
  field: string,
  audit: DisclosureAudit,
): string {
  if (!value.startsWith("#")) {
    return redactDisclosureValue(value, field, audit);
  }
  const decodedId = decodeCssIdentifier(value.slice(1));
  if (decodedId === null) {
    return redactDisclosureValue(value, field, audit);
  }
  const disclosedId = redactDisclosureValue(decodedId, field, audit);
  return disclosedId === decodedId ? value : `#${escapeCssIdentifier(disclosedId)}`;
}

function createDisclosedAttachmentId(seed: string, audit: DisclosureAudit): string {
  const boundedSeed = limitTextWithMarker(seed, MAX_ATTACHMENT_ID_TEXT_SEED_CHARACTERS);
  return createAttachmentId(redactDisclosureValue(boundedSeed, "attachment.id", audit));
}

function deriveAttachmentIdDisclosure(id: string, audit: DisclosureAudit): string {
  const hasAttachmentPrefix = id.startsWith("att_");
  const seed = hasAttachmentPrefix ? id.slice(4) : id;
  const disclosedSeed = redactDisclosureValue(
    limitTextWithMarker(seed, MAX_ATTACHMENT_ID_TEXT_SEED_CHARACTERS),
    "attachment.id",
    audit,
  );
  if (disclosedSeed === seed) {
    return id;
  }

  return createAttachmentId(disclosedSeed);
}

function redactOptionalDisclosureValue(
  value: string | null | undefined,
  field: string,
  audit: DisclosureAudit,
): string | null | undefined {
  return typeof value === "string" ? redactDisclosureValue(value, field, audit) : value;
}

function redactDisclosureValue(
  value: string,
  field: string,
  audit: DisclosureAudit,
): string {
  const redacted = redactRecognizedSensitiveText(value);
  if (redacted !== value) {
    markSensitiveField(audit, field, shouldRedactText(audit.disclosureMode));
  }

  return shouldRedactText(audit.disclosureMode) ? redacted : value;
}

function deriveArtifactsDisclosure(
  artifacts: UIAttachment["artifacts"],
  audit: DisclosureAudit,
): UIAttachment["artifacts"] {
  const shouldRedact = shouldRedactText(audit.disclosureMode);
  for (const field of ["screenshotCrop", "overlayImage"] as const) {
    if (artifacts[field] !== null) {
      markSensitiveField(audit, `artifacts.${field}`, shouldRedact);
    }
  }

  return shouldRedact
    ? { screenshotCrop: null, overlayImage: null }
    : { ...artifacts };
}

function redactKnownSensitiveAttachmentFields(
  attachment: UIAttachment,
  sourcePolicy: UIAttachmentPolicy,
  sourceMode: UIAttachmentDisclosureMode,
  targetMode: UIAttachmentDisclosureMode,
): { attachment: UIAttachment; redactedFields: string[] } {
  if (
    disclosureModeRank(sourceMode) <= disclosureModeRank(targetMode) ||
    !shouldRedactText(targetMode)
  ) {
    return { attachment, redactedFields: [] };
  }

  const declaredFields = new Set([
    ...sourcePolicy.includedSensitiveFields,
    ...sourcePolicy.sensitiveHints.filter(
      (field) => !sourcePolicy.redactedFields.includes(field),
    ),
  ]);
  if (declaredFields.size === 0) {
    return { attachment, redactedFields: [] };
  }
  const isDeclared = (field: string): boolean => declaredFields.has(field);
  const clearsSourceUrl = isDeclared("source.url");
  const redactScalar = (value: string | null, field: string): string | null =>
    value !== null && isDeclared(field)
      ? "[redacted:declared-sensitive]"
      : value;
  const redactedFields = new Set<string>();
  const locatorSemanticFields = [
    "element.role",
    "element.text",
    "element.accessibleName",
    "context.selectorHints",
  ];
  const clearsLocatorCollection = [
    "locatorBundle.primary",
    "locatorBundle.candidates",
    "locatorBundle.notes",
    ...locatorSemanticFields,
  ].some(isDeclared);
  const clearsVerifiedValue =
    clearsLocatorCollection || isDeclared("locatorBundle.stability.verifiedValue");
  const stability = { ...attachment.locatorBundle.stability };
  if (clearsVerifiedValue && stability.verifiedValue !== null && stability.verifiedValue !== undefined) {
    stability.verifiedValue = null;
    redactedFields.add("locatorBundle.stability.verifiedValue");
  }
  if (clearsLocatorCollection && stability.verifiedBy !== null && stability.verifiedBy !== undefined) {
    stability.verifiedBy = null;
  }
  if (isDeclared("locatorBundle.stability.failureReason")) {
    stability.failureReason = redactScalar(
      stability.failureReason,
      "locatorBundle.stability.failureReason",
    );
  }
  const locatorBundle = clearsLocatorCollection
    ? {
        ...attachment.locatorBundle,
        primary: null,
        candidates: [],
        stability,
      }
    : { ...attachment.locatorBundle, stability };
  if (
    clearsLocatorCollection &&
    (attachment.locatorBundle.primary !== null || attachment.locatorBundle.candidates.length > 0)
  ) {
    redactedFields.add("locatorBundle.candidates");
  }

  if (isDeclared("attachment.id") && !attachment.id.startsWith("att__redacted_")) {
    redactedFields.add("attachment.id");
  }
  if (clearsSourceUrl && attachment.source.url !== null) {
    redactedFields.add("source.url");
  }
  for (const field of [
    "source.title",
    "element.tagName",
    "element.role",
    "element.text",
    "element.accessibleName",
    "style.display",
    "style.color",
    "style.backgroundColor",
    ...UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.map((field) => `style.${field}`),
    "context.parentSummary",
    "context.nearbyText",
    "context.selectorHints",
    "locatorBundle.stability.failureReason",
    "artifacts.screenshotCrop",
    "artifacts.overlayImage",
  ]) {
    if (isDeclared(field)) {
      redactedFields.add(field);
    }
  }

  return {
    attachment: {
      ...attachment,
      id: isDeclared("attachment.id") && !attachment.id.startsWith("att__redacted_")
        ? createAttachmentId("declared-sensitive")
        : attachment.id,
      source: {
        ...attachment.source,
        url: clearsSourceUrl
          ? shouldRedactUrl(targetMode)
            ? null
            : "[redacted:declared-sensitive]"
          : attachment.source.url,
        title: redactScalar(attachment.source.title, "source.title"),
      },
      element: {
        ...attachment.element,
        tagName: redactScalar(attachment.element.tagName, "element.tagName") ?? "",
        role: redactScalar(attachment.element.role, "element.role"),
        text: redactScalar(attachment.element.text, "element.text"),
        accessibleName: redactScalar(attachment.element.accessibleName, "element.accessibleName"),
        ...(attachment.element.contentParts === undefined
          ? {}
          : {
              contentParts: attachment.element.contentParts.map((part) => ({
                ...part,
                tagName: redactScalar(part.tagName, "element.tagName") ?? "",
                role: redactScalar(part.role, "element.role"),
                text: redactScalar(part.text, "element.text"),
                accessibleName: redactScalar(part.accessibleName, "element.accessibleName"),
              })),
            }),
      },
      style: {
        display: redactScalar(attachment.style.display, "style.display"),
        color: redactScalar(attachment.style.color, "style.color"),
        backgroundColor: redactScalar(attachment.style.backgroundColor, "style.backgroundColor"),
        ...Object.fromEntries(UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.flatMap((field) =>
          Object.hasOwn(attachment.style, field)
            ? [[field, redactScalar(attachment.style[field] ?? null, `style.${field}`)]]
            : []
        )),
      },
      context: {
        ...attachment.context,
        parentSummary: redactScalar(attachment.context.parentSummary, "context.parentSummary"),
        nearbyText: isDeclared("context.nearbyText") ? [] : attachment.context.nearbyText,
        selectorHints: isDeclared("context.selectorHints") ? [] : attachment.context.selectorHints,
      },
      locatorBundle,
      artifacts: {
        screenshotCrop: isDeclared("artifacts.screenshotCrop")
          ? null
          : attachment.artifacts.screenshotCrop,
        overlayImage: isDeclared("artifacts.overlayImage") ? null : attachment.artifacts.overlayImage,
      },
    },
    redactedFields: [...redactedFields],
  };
}

function carryKnownSensitiveFields(
  policy: UIAttachmentPolicy,
  audit: DisclosureAudit,
): void {
  const redactedFields = new Set(policy.redactedFields);
  const includedSensitiveFields = new Set(policy.includedSensitiveFields);

  for (const field of redactedFields) {
    markSensitiveField(audit, field, true);
  }
  for (const field of includedSensitiveFields) {
    markSensitiveField(audit, field, false);
  }
  for (const field of policy.sensitiveHints) {
    if (redactedFields.has(field) || includedSensitiveFields.has(field)) {
      continue;
    }
    markSensitiveField(audit, field, shouldRedactKnownField(field, audit.disclosureMode));
  }
}

function createDisclosureAudit(
  disclosureMode: UIAttachmentDisclosureMode = "agent_safe",
): DisclosureAudit {
  return {
    disclosureMode: normalizeDisclosureMode(disclosureMode),
    redactedFields: new Set<string>(),
    sensitiveHints: new Set<string>(),
    includedSensitiveFields: new Set<string>(),
  };
}

function normalizeDisclosureMode(
  disclosureMode: UIAttachmentDisclosureMode,
): UIAttachmentDisclosureMode {
  return disclosureMode === "developer_diagnostic" || disclosureMode === "full_debug"
    ? disclosureMode
    : "agent_safe";
}

function canDeriveDisclosure(
  sourceMode: UIAttachmentDisclosureMode,
  targetMode: UIAttachmentDisclosureMode,
): boolean {
  return disclosureModeRank(sourceMode) >= disclosureModeRank(targetMode);
}

function disclosureModeRank(disclosureMode: UIAttachmentDisclosureMode): number {
  if (disclosureMode === "full_debug") {
    return 2;
  }

  if (disclosureMode === "developer_diagnostic") {
    return 1;
  }

  return 0;
}

export function redactRecognizedSensitiveText(value: string): string {
  return redactRecognizedSensitiveTextInternal(value, true);
}

function redactRecognizedSensitiveTextInternal(value: string, redactUrlUserInfo: boolean): string {
  let redacted = redactUrlUserInfo ? redactUrlUserInfoInText(value) : value;
  redacted = redacted.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[redacted:email]",
  );
  redacted = redacted.replace(
    /\bBearer\s+[A-Z0-9._~+\/-]{16,}={0,2}/gi,
    "Bearer [redacted:secret]",
  );
  redacted = redacted.replace(
    /\beyJ[A-Z0-9_-]{5,}\.[A-Z0-9_-]{5,}\.[A-Z0-9_-]{5,}\b/gi,
    "[redacted:secret]",
  );
  redacted = redacted.replace(
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    "[redacted:secret]",
  );
  redacted = redacted.replace(
    /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36})(?![A-Za-z0-9_-])/g,
    "[redacted:secret]",
  );
  redacted = redacted.replace(
    /\b(password|passwd|pwd|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|secret|token)(\s*[:=]\s*)(["']?)([^\s,;"'<>{}?#&]+)\3/gi,
    (match, label: string, separator: string, quote: string, candidate: string) =>
      isLikelyLabeledSecret(candidate)
        ? `${label}${separator}${quote}[redacted:secret]${quote}`
        : match,
  );
  redacted = redacted.replace(
    /\b(?:sk|pk|api|token|secret)[-_][A-Z0-9][A-Z0-9_-]{7,}\b/gi,
    "[redacted:secret]",
  );
  return redactPaymentCards(redacted);
}

function isLikelyLabeledSecret(value: string): boolean {
  if (value.length >= 12) {
    return true;
  }
  if (value.length < 8) {
    return false;
  }

  const characterClassCount = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Z0-9]/i].filter((pattern) =>
    pattern.test(value),
  ).length;
  return characterClassCount >= 2;
}

function redactPaymentCards(value: string): string {
  return value.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (candidate) => {
    const digits = candidate.replace(/[^\d]/g, "");
    return digits.length >= 13 && digits.length <= 19 && passesLuhnCheck(digits)
      ? "[redacted:payment-card]"
      : candidate;
  });
}

function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function markSensitiveField(
  audit: DisclosureAudit,
  field: string,
  redacted: boolean,
): void {
  audit.sensitiveHints.add(field);
  if (redacted) {
    audit.redactedFields.add(field);
    audit.includedSensitiveFields.delete(field);
    return;
  }

  if (!audit.redactedFields.has(field)) {
    audit.includedSensitiveFields.add(field);
  }
}

function shouldRedactText(disclosureMode: UIAttachmentDisclosureMode): boolean {
  return disclosureMode !== "full_debug";
}

function shouldRedactUrl(disclosureMode: UIAttachmentDisclosureMode): boolean {
  return disclosureMode === "agent_safe";
}

function shouldRedactKnownField(
  field: string,
  disclosureMode: UIAttachmentDisclosureMode,
): boolean {
  if (field === "source.url") {
    return shouldRedactUrl(disclosureMode);
  }

  return shouldRedactText(disclosureMode);
}

function getRedactionLevel(
  disclosureMode: UIAttachmentDisclosureMode,
): UIAttachmentPolicy["redactionLevel"] {
  if (disclosureMode === "full_debug") {
    return "debug";
  }

  if (disclosureMode === "developer_diagnostic") {
    return "balanced";
  }

  return "strict";
}

function findFormLabel(element: HTMLElement): string | null {
  if (!["input", "textarea", "select"].includes(element.tagName.toLowerCase())) {
    return null;
  }

  const labels = (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).labels;
  for (let index = 0; labels && index < Math.min(labels.length, MAX_FORM_LABELS); index += 1) {
    const label = labels[index];
    if (!label) continue;
    const text = normalizeText(collectSelectedDomText(label));
    if (text) return text;
  }

  const wrappingLabel = element.closest("label");
  return wrappingLabel ? normalizeText(collectSelectedDomText(wrappingLabel)) : null;
}

function quoteLocatorString(value: string): string {
  return JSON.stringify(value);
}

function dedupeLocators(candidates: UIAttachmentLocator[]): UIAttachmentLocator[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.strategy}:${candidate.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scoreLocatorStability(
  primary: UIAttachmentLocator | null,
  candidates: UIAttachmentLocator[],
): number {
  if (!primary) {
    return 0;
  }

  const scoredPrimary =
    primary.notes === "structural fallback"
      ? candidates.find((candidate) => candidate.notes !== "structural fallback") ?? null
      : primary;
  if (!scoredPrimary) {
    return 0;
  }

  const primaryScore = Math.round(scoredPrimary.confidence * 70);
  const scoredCandidateCount = candidates.filter(
    (candidate) => candidate.notes !== "structural fallback",
  ).length;
  const fallbackScore = Math.min(Math.max(scoredCandidateCount - 1, 0), 3) * 4;
  return Math.min(100, primaryScore + fallbackScore);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function escapeCssIdentifier(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  let escaped = "";
  const firstCodeUnit = value.charCodeAt(0);

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x0000) {
      escaped += "\uFFFD";
      continue;
    }

    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && firstCodeUnit === 0x002d && codeUnit >= 0x0030 && codeUnit <= 0x0039)
    ) {
      escaped += `\\${codeUnit.toString(16)} `;
      continue;
    }

    if (index === 0 && codeUnit === 0x002d && value.length === 1) {
      escaped += "\\-";
      continue;
    }

    const character = value[index] ?? "";
    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      escaped += character;
      continue;
    }

    escaped += `\\${character}`;
  }

  return escaped;
}

function decodeCssIdentifier(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      decoded += character;
      index += 1;
      continue;
    }

    const escapedStart = index + 1;
    const escaped = value[escapedStart];
    if (!escaped || escaped === "\n" || escaped === "\r" || escaped === "\f") {
      return null;
    }
    const hexMatch = value.slice(escapedStart).match(/^[0-9a-fA-F]{1,6}/);
    if (hexMatch) {
      const codePoint = Number.parseInt(hexMatch[0], 16);
      decoded += codePoint === 0 || codePoint > 0x10ffff
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
      index = escapedStart + hexMatch[0].length;
      if (/\s/.test(value[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    decoded += escaped;
    index = escapedStart + 1;
  }
  return decoded;
}
