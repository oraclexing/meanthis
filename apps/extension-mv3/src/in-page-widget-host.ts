import {
  type InPageWidgetInitMessage,
  type InPageWidgetPrivatePhase,
  UI_ATTACH_IN_PAGE_WIDGET_PATH,
  parseInPageWidgetInitMessage,
  parseInPageWidgetPhaseMessage,
} from "./in-page-widget-contract";

export const IN_PAGE_WIDGET_LAYER = 2_147_483_647;
export const IN_PAGE_WIDGET_CONNECT = "meanthis.widget.connect";
export const IN_PAGE_WIDGET_LAYOUT = "meanthis.widget.layout";

const HOST_SELECTOR = "[data-ui-attach-in-page-widget-host]";
const FRAME_SANDBOX = "allow-scripts allow-same-origin";
const FRAME_ALLOW = "clipboard-write";
const DEFAULT_MAX_TAMPER_REPAIRS = 2;
const MAX_TAMPER_REPAIRS = 8;
const DEFAULT_PRIVATE_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_PRIVATE_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 120_000;
const DEFAULT_WORKBAR_WIDTH = 292;
const MIN_WORKBAR_WIDTH = 240;
const MAX_WORKBAR_WIDTH = 480;
const DEFAULT_SCOPE_HEIGHT = 224;
const MIN_SCOPE_HEIGHT = 128;
const MAX_SCOPE_HEIGHT = 344;
const COLLAPSED_WIDGET_SIZE = 48;
const WIDGET_EDGE_OFFSET = 20;
const WIDGET_VIEWPORT_GUTTER = WIDGET_EDGE_OFFSET * 2;
const WIDGET_TITLE = "MeanThis";
const DEFAULT_STARTING_LABEL = "MeanThis is starting\u2026";
const DEFAULT_FAILURE_LABEL = "MeanThis could not start";

export type InPageWidgetPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

export type InPageWidgetLayout = "collapsed" | "workbar" | "scope" | "expanded";

export interface InPageWidgetLayoutMessage {
  type: typeof IN_PAGE_WIDGET_LAYOUT;
  mode: InPageWidgetLayout;
  width?: number;
  height?: number;
}

export type InPageWidgetHostFailureCode =
  | "DISPOSED"
  | "TAMPER_REPAIR_LIMIT_REACHED"
  | "TAMPER_REPAIR_FAILED"
  | "PRIVATE_INITIALIZATION_FAILED"
  | "PRIVATE_HANDSHAKE_TIMEOUT"
  | "READY_TIMEOUT";

export interface InPageWidgetHostFailure {
  code: InPageWidgetHostFailureCode;
  integrityIssue?: InPageWidgetIntegrityIssue;
  phase: InPageWidgetHostPhase;
  repairs: number;
}

export type InPageWidgetIntegrityIssue =
  | "host-parent"
  | "host-attributes"
  | "host-style"
  | "host-light-dom"
  | "frame-parent"
  | "frame-srcdoc-empty"
  | "frame-srcdoc-content"
  | "frame-event-handler"
  | "frame-name"
  | "frame-permission-attribute"
  | "frame-isolation-attribute"
  | "frame-focus-attribute"
  | "frame-projection-attribute"
  | "frame-visibility-attribute"
  | "frame-marker"
  | "frame-referrer-policy"
  | "frame-sandbox"
  | "frame-allow"
  | "frame-src"
  | "frame-style"
  | "frame-title"
  | "frame-reset";

export type InPageWidgetHostPhase =
  | "frame-loading"
  | "frame-loaded"
  | "initialization-delivered"
  | InPageWidgetPrivatePhase
  | "layout-ack";

export type InPageWidgetHostReadiness =
  | { ready: true }
  | { ready: false; failure: InPageWidgetHostFailure };

export interface InPageWidgetHostController {
  readonly element: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  show(): void;
  hide(): void;
  focus(): void;
  setPosition(position: InPageWidgetPosition): void;
  initialize(message: unknown): boolean;
  waitUntilReady(): Promise<InPageWidgetHostReadiness>;
  dispose(): void;
}

export interface InPageWidgetHostOptions {
  document: Document;
  window?: Window & typeof globalThis;
  /** A parameterless URL returned by the extension runtime for the widget entry. */
  sourceUrl?: string | (() => string);
  /** Factory alias for integrations that must resolve the current extension URL lazily. */
  createFrameUrl?: () => string;
  position?: InPageWidgetPosition;
  maxTamperRepairs?: number;
  privateHandshakeTimeoutMs?: number;
  /** Total time allowed from valid initialization until the private layout handshake. */
  readyTimeoutMs?: number;
  startingLabel?: string;
  failureLabel?: string;
  onFailure?(failure: InPageWidgetHostFailure): void;
  createMessageChannel?: () => MessageChannel;
  /** Test seam for the exact-origin readiness check before private-port delivery. */
  getFrameDocument?(frame: HTMLIFrameElement): Document | null;
  /** Test seam for browsers or DOM harnesses that do not expose iframe.contentWindow. */
  postFrameMessage?(
    frame: HTMLIFrameElement,
    message: unknown,
    targetOrigin: string,
    transfer: Transferable[],
  ): boolean;
}

interface ActiveHost {
  dispose(): void;
}

const activeHosts = new WeakMap<Document, ActiveHost>();

/**
 * Mounts an extension-owned micro-surface without placing capability or task
 * data in the page DOM. The iframe lives in a closed shadow root so page CSS
 * and the document-level selection iframe guard cannot reach it.
 */
export function createInPageWidgetHost(
  options: InPageWidgetHostOptions,
): InPageWidgetHostController {
  const root = options.document;
  const rootView = options.window ?? root.defaultView;
  if (!rootView || rootView.document !== root) {
    throw new Error("The MeanThis in-page widget requires its document window.");
  }
  const view: Window & typeof globalThis = rootView;
  if (view.top && view.top !== view) {
    throw new Error("The MeanThis in-page widget can only mount in the top document.");
  }
  if (!root.documentElement) {
    throw new Error("The MeanThis in-page widget requires a document element.");
  }

  const sourceUrl = resolveSourceUrl(options);
  const source = validateExtensionSourceUrl(sourceUrl);
  const maxTamperRepairs = validateRepairBudget(options.maxTamperRepairs);
  const privateHandshakeTimeoutMs = validatePrivateHandshakeTimeout(
    options.privateHandshakeTimeoutMs,
  );
  const readyTimeoutMs = validateReadyTimeout(options.readyTimeoutMs);
  let position = validatePosition(options.position ?? "bottom-right");
  let layout: InPageWidgetLayout = "collapsed";
  let workbarWidth = DEFAULT_WORKBAR_WIDTH;
  let scopeHeight = DEFAULT_SCOPE_HEIGHT;
  let visible = true;
  let disposed = false;
  let failed = false;
  let repairs = 0;
  let loaded = false;
  let initialization: InPageWidgetInitMessage | null = null;
  let initializationSent = false;
  let privatePort: MessagePort | null = null;
  let privateHandshakeTimer: number | null = null;
  let readyTimeoutTimer: number | null = null;
  let privateHandshakeAcknowledged = false;
  let lifecycleHydrationWindowGranted = false;
  let phase: InPageWidgetHostPhase = "frame-loading";
  let lastIntegrityIssue: InPageWidgetIntegrityIssue | null = null;
  let readinessSettled = false;
  let settleReadiness!: (value: InPageWidgetHostReadiness) => void;
  const readiness = new Promise<InPageWidgetHostReadiness>((resolve) => {
    settleReadiness = resolve;
  });

  // Stop a same-realm predecessor before removing reload orphans. Without
  // this registry, two live observers could repeatedly restore each other.
  activeHosts.get(root)?.dispose();
  root.querySelectorAll(HOST_SELECTOR).forEach((candidate) => candidate.remove());

  const host = root.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const frame = root.createElement("iframe");
  const statusSurface = root.createElement("div");
  const expectedHostStyle = (): string => createHostStyle(
    root,
    visible,
    position,
    layout,
    privateHandshakeAcknowledged,
    false,
    workbarWidth,
    scopeHeight,
  );
  const expectedFrameStyle = createFrameStyle(root);

  frame.addEventListener("load", handleFrameLoad);
  applyHostContract();
  applyFrameContract();
  applyStatusContract();
  shadow.append(frame, statusSurface);
  root.documentElement.append(host);

  const observer = new view.MutationObserver((records) => {
    checkForTampering(records.some((record) => mutationMayResetFrame(record)));
  });
  observeIntegrity();

  const controller: InPageWidgetHostController = {
    element: host,
    frame,
    show,
    hide,
    focus,
    setPosition,
    initialize,
    waitUntilReady: () => readiness,
    dispose,
  };
  activeHosts.set(root, controller);
  return controller;

  function show(): void {
    if (disposed || failed || !host.isConnected) return;
    visible = true;
    host.style.cssText = expectedHostStyle();
  }

  function hide(): void {
    if (disposed || failed || !host.isConnected) return;
    visible = false;
    host.style.cssText = expectedHostStyle();
  }

  function focus(): void {
    if (disposed || failed || !visible || !privateHandshakeAcknowledged || !isIntact()) return;
    frame.focus({ preventScroll: true });
  }

  function setPosition(nextPosition: InPageWidgetPosition): void {
    if (disposed || failed || !host.isConnected) return;
    position = validatePosition(nextPosition);
    host.style.cssText = expectedHostStyle();
  }

  function initialize(message: unknown): boolean {
    if (disposed || failed || !isIntact()) return false;
    const parsed = parseInPageWidgetInitMessage(message);
    if (!parsed) return false;
    if (initialization) return sameInitialization(initialization, parsed);

    // Clone only the exact, validated primitive fields. The caller's object is
    // never retained and no capability is reflected into DOM state.
    initialization = {
      type: parsed.type,
      schemaVersion: parsed.schemaVersion,
      surfaceId: parsed.surfaceId,
      capability: parsed.capability,
    };
    scheduleReadyTimeout();
    if (loaded) deliverInitialization();
    return !failed;
  }

  function dispose(): void {
    if (disposed) return;
    clearReadyTimeout();
    settleReadinessOnce({
      ready: false,
      failure: { code: "DISPOSED", phase, repairs },
    });
    disposed = true;
    observer.disconnect();
    frame.removeEventListener("load", handleFrameLoad);
    closePrivatePort();
    initialization = null;
    host.remove();
    if (activeHosts.get(root) === controller) activeHosts.delete(root);
  }

  function handleFrameLoad(): void {
    if (disposed || failed) return;
    if (!isIntact()) {
      checkForTampering();
      return;
    }
    if (!isFrameDocumentReadyForMessaging()) {
      clearPrivateHandshakeTimeout();
      closePrivatePort();
      initializationSent = false;
      loaded = false;
      phase = "frame-loading";
      return;
    }
    if (loaded) {
      if (!consumeRepairBudget()) return;
      closePrivatePort();
      initializationSent = false;
      loaded = false;
      withIntegrityObserverPaused(() => restartFrameBrowsingContext());
      return;
    }
    clearPrivateHandshakeTimeout();
    loaded = true;
    phase = "frame-loaded";
    deliverInitialization();
  }

  function isFrameDocumentReadyForMessaging(): boolean {
    try {
      if (options.getFrameDocument) return options.getFrameDocument(frame) === null;
      // A page-owned about:blank/srcdoc document is synchronously visible here.
      // The extension document is cross-origin to the content-script page and
      // therefore exposes no contentDocument. Do not use "*": the transferred
      // private port must never be delivered to the inherited page origin.
      return frame.contentDocument === null;
    } catch {
      return false;
    }
  }

  function deliverInitialization(): void {
    if (
      disposed || failed || initializationSent || !initialization || !loaded || !isIntact()
    ) return;
    // Recheck at the sink as initialize() may run after an earlier valid load
    // but before an inspection-triggered srcdoc/navigation mutation is observed.
    if (!isFrameDocumentReadyForMessaging()) {
      loaded = false;
      phase = "frame-loading";
      return;
    }
    const createChannel = options.createMessageChannel ?? (
      typeof view.MessageChannel === "function"
        ? () => new view.MessageChannel()
        : typeof MessageChannel === "function"
          ? () => new MessageChannel()
          : null
    );
    if (!createChannel) {
      failClosed("PRIVATE_INITIALIZATION_FAILED");
      return;
    }

    let channel: MessageChannel | undefined;
    try {
      const nextChannel = createChannel();
      channel = nextChannel;
      nextChannel.port1.onmessage = handlePrivateMessage;
      nextChannel.port1.onmessageerror = handlePrivateMessageError;
      nextChannel.port1.start();
      const connectMessage = { type: IN_PAGE_WIDGET_CONNECT };
      if (options.postFrameMessage) {
        if (!options.postFrameMessage(
          frame,
          connectMessage,
          source.targetOrigin,
          [nextChannel.port2],
        )) throw new Error("The MeanThis widget frame is unavailable.");
      } else {
        const target = frame.contentWindow;
        if (!target) throw new Error("The MeanThis widget frame is unavailable.");
        target.postMessage(connectMessage, source.targetOrigin, [nextChannel.port2]);
      }
      nextChannel.port1.postMessage(initialization);
      privatePort = nextChannel.port1;
      initializationSent = true;
      phase = "initialization-delivered";
      schedulePrivateHandshakeTimeout();
    } catch {
      channel?.port1.close();
      channel?.port2.close();
      failClosed("PRIVATE_INITIALIZATION_FAILED");
    }
  }

  function handlePrivateMessage(event: MessageEvent<unknown>): void {
    if (disposed || failed || !privatePort) return;
    const phaseMessage = parseInPageWidgetPhaseMessage(event.data);
    if (phaseMessage) {
      phase = phaseMessage.phase;
      if (isTerminalPrivateFailurePhase(phaseMessage.phase)) {
        failClosed("PRIVATE_INITIALIZATION_FAILED");
        return;
      }
      if (phaseMessage.phase === "lifecycle-ready" && !lifecycleHydrationWindowGranted) {
        // The background has authenticated this exact widget document and
        // lifecycle port. Give the now-trusted UI one fresh, bounded window to
        // hydrate storage-backed state before it sends the decisive layout ACK.
        // Repeated diagnostics cannot keep the private channel alive forever.
        lifecycleHydrationWindowGranted = true;
        schedulePrivateHandshakeTimeout();
      }
      return;
    }
    const message = parseInPageWidgetLayoutMessage(event.data);
    if (!message) return;
    acknowledgePrivateHandshake();
    const nextWorkbarWidth = message.mode === "workbar" || message.mode === "scope"
      ? message.width ?? DEFAULT_WORKBAR_WIDTH
      : workbarWidth;
    const nextScopeHeight = message.mode === "scope"
      ? message.height ?? DEFAULT_SCOPE_HEIGHT
      : scopeHeight;
    if (message.mode === layout && nextWorkbarWidth === workbarWidth &&
        nextScopeHeight === scopeHeight) return;
    layout = message.mode;
    workbarWidth = nextWorkbarWidth;
    scopeHeight = nextScopeHeight;
    host.style.cssText = expectedHostStyle();
  }

  function handlePrivateMessageError(): void {
    failClosed("PRIVATE_INITIALIZATION_FAILED");
  }

  function acknowledgePrivateHandshake(): void {
    clearPrivateHandshakeTimeout();
    clearReadyTimeout();
    if (privateHandshakeAcknowledged) return;
    privateHandshakeAcknowledged = true;
    phase = "layout-ack";
    settleReadinessOnce({ ready: true });
    statusSurface.style.setProperty("display", "none", "important");
    host.style.cssText = expectedHostStyle();
  }

  function schedulePrivateHandshakeTimeout(): void {
    clearPrivateHandshakeTimeout();
    privateHandshakeTimer = view.setTimeout(() => {
      privateHandshakeTimer = null;
      failClosed("PRIVATE_HANDSHAKE_TIMEOUT");
    }, privateHandshakeTimeoutMs);
  }

  function clearPrivateHandshakeTimeout(): void {
    if (privateHandshakeTimer === null) return;
    view.clearTimeout(privateHandshakeTimer);
    privateHandshakeTimer = null;
  }

  function scheduleReadyTimeout(): void {
    clearReadyTimeout();
    readyTimeoutTimer = view.setTimeout(() => {
      readyTimeoutTimer = null;
      failClosed("READY_TIMEOUT");
    }, readyTimeoutMs);
  }

  function clearReadyTimeout(): void {
    if (readyTimeoutTimer === null) return;
    view.clearTimeout(readyTimeoutTimer);
    readyTimeoutTimer = null;
  }

  function closePrivatePort(): void {
    clearPrivateHandshakeTimeout();
    privateHandshakeAcknowledged = false;
    lifecycleHydrationWindowGranted = false;
    if (!disposed && !failed && host.isConnected) {
      applyStatusContract();
      host.style.cssText = expectedHostStyle();
    }
    if (!privatePort) return;
    privatePort.onmessage = null;
    privatePort.onmessageerror = null;
    privatePort.close();
    privatePort = null;
  }

  function checkForTampering(forceFrameRecovery = false): void {
    if (disposed || failed) return;
    const integrityIssue = inspectIntegrityIssue();
    if (!integrityIssue && !forceFrameRecovery) return;
    lastIntegrityIssue = integrityIssue ?? "frame-reset";
    if (integrityIssue === "frame-srcdoc-empty") {
      // Browser inspection/control tooling can reflect an inert empty srcdoc
      // placeholder onto an extension iframe. Remove that placeholder and
      // reconnect without spending the active-tamper repair budget. Non-empty
      // srcdoc content remains a budgeted integrity violation below.
      closePrivatePort();
      initializationSent = false;
      loaded = false;
      withIntegrityObserverPaused(() => frame.removeAttribute("srcdoc"));
      if (!isIntact()) {
        failClosed("TAMPER_REPAIR_FAILED");
        return;
      }
      lastIntegrityIssue = null;
      return;
    }
    if (!consumeRepairBudget()) return;
    if (forceFrameRecovery && isIntact()) {
      closePrivatePort();
      initializationSent = false;
      loaded = false;
      withIntegrityObserverPaused(() => restartFrameBrowsingContext());
      return;
    }
    try {
      withIntegrityObserverPaused(() => repairIntegrity());
    } catch {
      failClosed("TAMPER_REPAIR_FAILED");
      return;
    }
    if (!isIntact()) {
      failClosed("TAMPER_REPAIR_FAILED");
      return;
    }
    lastIntegrityIssue = null;
  }

  function consumeRepairBudget(): boolean {
    if (repairs >= maxTamperRepairs) {
      failClosed("TAMPER_REPAIR_LIMIT_REACHED");
      return false;
    }
    repairs += 1;
    return true;
  }

  function repairIntegrity(): void {
    const hostWasDisconnected = !host.isConnected;
    const hostWasMisparented = host.isConnected && host.parentNode !== root.documentElement;
    const frameWasIntact = isFrameIntact();
    const frameWillReload = hostWasDisconnected || hostWasMisparented || !frameWasIntact;
    if (frameWillReload) {
      closePrivatePort();
      initializationSent = false;
      loaded = false;
    }
    applyHostContract();
    host.replaceChildren();
    if (!frameWasIntact) applyFrameContract();
    if (!frameWasIntact && (
      frame.parentNode !== shadow || statusSurface.parentNode !== shadow ||
      shadow.childNodes.length !== 2
    )) {
      applyStatusContract();
      shadow.replaceChildren(frame, statusSurface);
    }
    if (host.parentNode !== root.documentElement) root.documentElement.append(host);
    if (hostWasMisparented) restartFrameBrowsingContext();
  }

  function restartFrameBrowsingContext(): void {
    if (disposed || failed || !host.isConnected) return;
    frame.remove();
    applyFrameContract();
    applyStatusContract();
    shadow.replaceChildren(frame, statusSurface);
  }

  function mutationMayResetFrame(record: MutationRecord): boolean {
    if (record.type === "attributes") {
      return record.target === frame && record.attributeName === "src";
    }
    for (const node of record.removedNodes) {
      if (node === host || node === frame) return true;
      if (node.nodeType === 1 && (
        (node as Element).contains(host) || (node as Element).contains(frame)
      )) return true;
    }
    return false;
  }

  function observeIntegrity(): void {
    if (disposed || failed) return;
    observer.observe(root, { childList: true });
    observer.observe(root.documentElement, { childList: true });
    observer.observe(host, { attributes: true, childList: true });
    observer.observe(shadow, { attributes: true, childList: true, subtree: true });
  }

  function withIntegrityObserverPaused(action: () => void): void {
    observer.disconnect();
    try {
      action();
    } finally {
      observeIntegrity();
    }
  }

  function isIntact(): boolean {
    return inspectIntegrityIssue() === null;
  }

  function inspectIntegrityIssue(): InPageWidgetIntegrityIssue | null {
    if (host.parentNode !== root.documentElement) return "host-parent";
    if (!hasExactAttributes(host, [
      "data-ui-attach-ignore",
      "data-ui-attach-in-page-widget-host",
      "style",
    ]) || host.dataset.uiAttachIgnore !== "true" ||
        host.dataset.uiAttachInPageWidgetHost !== "true") return "host-attributes";
    if (!matchesStyleContract(host.style, expectedHostStyle(), root)) return "host-style";
    if (host.childNodes.length !== 0) return "host-light-dom";
    if (
      frame.parentNode !== shadow || statusSurface.parentNode !== shadow ||
      shadow.childNodes.length !== 2 || shadow.firstChild !== frame ||
      shadow.lastChild !== statusSurface
    ) return "frame-parent";
    const unsafeAttribute = inspectUnsafeFrameAttribute(frame);
    if (unsafeAttribute) return unsafeAttribute;
    if (frame.getAttribute("data-meanthis-widget-frame") !== "") return "frame-marker";
    if (frame.getAttribute("referrerpolicy") !== "no-referrer") {
      return "frame-referrer-policy";
    }
    if (frame.getAttribute("sandbox") !== FRAME_SANDBOX) return "frame-sandbox";
    if (frame.getAttribute("allow") !== FRAME_ALLOW) return "frame-allow";
    if (frame.getAttribute("src") !== sourceUrl) return "frame-src";
    if (!matchesStyleContract(frame.style, expectedFrameStyle, root)) return "frame-style";
    if (frame.title !== WIDGET_TITLE) return "frame-title";
    return null;
  }

  function isHostIntact(): boolean {
    return host.parentNode === root.documentElement &&
      hasExactAttributes(host, [
        "data-ui-attach-ignore",
        "data-ui-attach-in-page-widget-host",
        "style",
      ]) &&
      host.dataset.uiAttachIgnore === "true" &&
      host.dataset.uiAttachInPageWidgetHost === "true" &&
      matchesStyleContract(host.style, expectedHostStyle(), root) &&
      host.childNodes.length === 0;
  }

  function isFrameIntact(): boolean {
    return frame.parentNode === shadow &&
      statusSurface.parentNode === shadow && shadow.childNodes.length === 2 &&
      shadow.firstChild === frame && shadow.lastChild === statusSurface &&
      !inspectUnsafeFrameAttribute(frame) &&
      frame.getAttribute("data-meanthis-widget-frame") === "" &&
      frame.getAttribute("referrerpolicy") === "no-referrer" &&
      frame.getAttribute("sandbox") === FRAME_SANDBOX &&
      frame.getAttribute("allow") === FRAME_ALLOW &&
      frame.getAttribute("src") === sourceUrl &&
      matchesStyleContract(frame.style, expectedFrameStyle, root) &&
      frame.title === WIDGET_TITLE;
  }

  function applyHostContract(): void {
    for (const attribute of host.getAttributeNames()) host.removeAttribute(attribute);
    host.dataset.uiAttachInPageWidgetHost = "true";
    host.dataset.uiAttachIgnore = "true";
    host.style.cssText = expectedHostStyle();
  }

  function applyFrameContract(): void {
    for (const attribute of frame.getAttributeNames()) frame.removeAttribute(attribute);
    frame.setAttribute("data-meanthis-widget-frame", "");
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.setAttribute("allow", FRAME_ALLOW);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", WIDGET_TITLE);
    frame.setAttribute("src", sourceUrl);
    frame.style.cssText = expectedFrameStyle;
  }

  function applyStatusContract(): void {
    statusSurface.textContent = normalizeStatusLabel(
      options.startingLabel,
      DEFAULT_STARTING_LABEL,
    );
    statusSurface.setAttribute("role", "status");
    statusSurface.setAttribute("aria-live", "polite");
    statusSurface.style.cssText = createStatusStyle(root, false);
  }

  function failClosed(code: InPageWidgetHostFailureCode): void {
    if (failed || disposed) return;
    failed = true;
    observer.disconnect();
    frame.removeEventListener("load", handleFrameLoad);
    clearReadyTimeout();
    closePrivatePort();
    initialization = null;
    const failure = {
      code,
      ...(lastIntegrityIssue ? { integrityIssue: lastIntegrityIssue } : {}),
      phase,
      repairs,
    } satisfies InPageWidgetHostFailure;
    frame.remove();
    statusSurface.textContent = `${normalizeStatusLabel(
      options.failureLabel,
      DEFAULT_FAILURE_LABEL,
    )} \u00b7 ${formatFailurePhase(failure)}`;
    statusSurface.style.cssText = createStatusStyle(root, true);
    host.style.cssText = createHostStyle(root, visible, position, "expanded", false, true);
    settleReadinessOnce({ ready: false, failure });
    try {
      options.onFailure?.(failure);
    } catch {
      // The host is already failed closed; consumer error reporting cannot
      // restart it or expose the retained capability.
    }
  }

  function settleReadinessOnce(value: InPageWidgetHostReadiness): void {
    if (readinessSettled) return;
    readinessSettled = true;
    settleReadiness(value);
  }
}

function resolveSourceUrl(options: InPageWidgetHostOptions): string {
  if (options.createFrameUrl && options.sourceUrl !== undefined) {
    throw new Error("Provide one MeanThis widget URL source, not both.");
  }
  const source = options.createFrameUrl ?? options.sourceUrl;
  const value = typeof source === "function" ? source() : source;
  if (typeof value !== "string") {
    throw new Error("A parameterless extension URL is required for the MeanThis widget.");
  }
  return value;
}

function validateExtensionSourceUrl(value: string): { targetOrigin: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The MeanThis widget requires a parameterless extension URL.");
  }
  if (
    value !== value.trim() || parsed.protocol !== "chrome-extension:" || !parsed.host ||
    parsed.username !== "" || parsed.password !== "" || parsed.port !== "" ||
    parsed.pathname !== UI_ATTACH_IN_PAGE_WIDGET_PATH || parsed.search !== "" ||
    parsed.hash !== "" || value.includes("?") || value.includes("#")
  ) {
    throw new Error("The MeanThis widget requires a parameterless extension URL.");
  }
  return { targetOrigin: `chrome-extension://${parsed.host}` };
}

function isTerminalPrivateFailurePhase(phase: InPageWidgetPrivatePhase): boolean {
  return phase !== "private-port-received" && phase !== "runtime-register-ok" &&
    phase !== "lifecycle-ready" && phase !== "authenticated-ui-ready";
}

function validateRepairBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_MAX_TAMPER_REPAIRS;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_TAMPER_REPAIRS) {
    throw new Error(`maxTamperRepairs must be an integer from 0 to ${MAX_TAMPER_REPAIRS}.`);
  }
  return budget;
}

function validatePrivateHandshakeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_PRIVATE_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_PRIVATE_HANDSHAKE_TIMEOUT_MS) {
    throw new Error(
      `privateHandshakeTimeoutMs must be an integer from 1 to ${MAX_PRIVATE_HANDSHAKE_TIMEOUT_MS}.`,
    );
  }
  return timeout;
}

function validateReadyTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_READY_TIMEOUT_MS) {
    throw new Error(
      `readyTimeoutMs must be an integer from 1 to ${MAX_READY_TIMEOUT_MS}.`,
    );
  }
  return timeout;
}

function validatePosition(value: InPageWidgetPosition): InPageWidgetPosition {
  if (
    value !== "bottom-right" && value !== "bottom-left" &&
    value !== "top-right" && value !== "top-left"
  ) {
    throw new Error("Unsupported MeanThis widget position.");
  }
  return value;
}

function sameInitialization(
  first: InPageWidgetInitMessage,
  second: InPageWidgetInitMessage,
): boolean {
  return first.type === second.type && first.schemaVersion === second.schemaVersion &&
    first.surfaceId === second.surfaceId && first.capability === second.capability;
}

export function parseInPageWidgetLayoutMessage(
  value: unknown,
): InPageWidgetLayoutMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!Object.hasOwn(record, "type") || !Object.hasOwn(record, "mode")) {
    return null;
  }
  if (
    record.type !== IN_PAGE_WIDGET_LAYOUT ||
    (record.mode !== "collapsed" && record.mode !== "workbar" &&
      record.mode !== "scope" && record.mode !== "expanded")
  ) return null;
  if (record.mode === "workbar") {
    if (
      keys.length !== 3 || !Object.hasOwn(record, "width") ||
      typeof record.width !== "number" || !Number.isInteger(record.width) ||
      record.width < MIN_WORKBAR_WIDTH || record.width > MAX_WORKBAR_WIDTH
    ) return null;
    return {
      type: IN_PAGE_WIDGET_LAYOUT,
      mode: record.mode,
      width: record.width,
    };
  }
  if (record.mode === "scope") {
    if (
      keys.length !== 4 || !Object.hasOwn(record, "width") ||
      !Object.hasOwn(record, "height") ||
      typeof record.width !== "number" || !Number.isInteger(record.width) ||
      record.width < MIN_WORKBAR_WIDTH || record.width > MAX_WORKBAR_WIDTH ||
      typeof record.height !== "number" || !Number.isInteger(record.height) ||
      record.height < MIN_SCOPE_HEIGHT || record.height > MAX_SCOPE_HEIGHT
    ) return null;
    return {
      type: IN_PAGE_WIDGET_LAYOUT,
      mode: record.mode,
      width: record.width,
      height: record.height,
    };
  }
  if (keys.length !== 2) return null;
  return {
    type: IN_PAGE_WIDGET_LAYOUT,
    mode: record.mode,
  };
}

function createHostStyle(
  root: Document,
  visible: boolean,
  position: InPageWidgetPosition,
  layout: InPageWidgetLayout,
  interactive: boolean,
  failedVisual = false,
  workbarWidth = DEFAULT_WORKBAR_WIDTH,
  scopeHeight = DEFAULT_SCOPE_HEIGHT,
): string {
  const style = root.createElement("div").style;
  const expanded = layout === "expanded";
  const workbar = layout === "workbar";
  const scope = layout === "scope";
  const reducedMotion = root.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ?? false;
  setImportantProperties(style, {
    all: "initial",
    position: "fixed",
    display: visible ? "block" : "none",
    "box-sizing": "border-box",
    width: failedVisual
      ? "320px"
      : !interactive
      ? "144px"
      : expanded
      ? "360px"
      : workbar || scope
      ? `${workbarWidth}px`
      : `${COLLAPSED_WIDGET_SIZE}px`,
    "max-width": `calc(100vw - ${WIDGET_VIEWPORT_GUTTER}px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))`,
    height: failedVisual
      ? "76px"
      : !interactive
      ? "52px"
      : expanded
      ? "560px"
      : scope
      ? `${scopeHeight}px`
      : workbar
      ? "64px"
      : `${COLLAPSED_WIDGET_SIZE}px`,
    "max-height": `calc(100vh - ${WIDGET_VIEWPORT_GUTTER}px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))`,
    overflow: "hidden",
    opacity: visible ? "1" : "0",
    "pointer-events": interactive ? "auto" : "none",
    "z-index": String(IN_PAGE_WIDGET_LAYER),
    "border-radius": !interactive
      ? "14px"
      : workbar || layout === "collapsed"
      ? "999px"
      : "18px",
    "box-shadow": workbar
      ? "0 14px 34px rgb(0 0 0 / 38%), 0 2px 8px rgb(0 0 0 / 24%)"
      : "none",
    "color-scheme": "light dark",
    transition: interactive && !reducedMotion
      ? "width 170ms cubic-bezier(0.2, 0.8, 0.2, 1), height 170ms cubic-bezier(0.2, 0.8, 0.2, 1), border-radius 170ms cubic-bezier(0.2, 0.8, 0.2, 1)"
      : "none",
    contain: workbar || scope ? "layout style" : "layout style paint",
    top: position.startsWith("top-")
      ? `calc(${WIDGET_EDGE_OFFSET}px + env(safe-area-inset-top, 0px))`
      : "auto",
    bottom: position.startsWith("bottom-")
      ? `calc(${WIDGET_EDGE_OFFSET}px + env(safe-area-inset-bottom, 0px))`
      : "auto",
    left: position.endsWith("-left")
      ? `calc(${WIDGET_EDGE_OFFSET}px + env(safe-area-inset-left, 0px))`
      : "auto",
    right: position.endsWith("-right")
      ? `calc(${WIDGET_EDGE_OFFSET}px + env(safe-area-inset-right, 0px))`
      : "auto",
  });
  return style.cssText;
}

function createStatusStyle(root: Document, failed: boolean): string {
  const style = root.createElement("div").style;
  setImportantProperties(style, {
    all: "initial",
    position: "absolute",
    inset: "0",
    display: "flex",
    "box-sizing": "border-box",
    "align-items": "center",
    "justify-content": "center",
    padding: failed ? "12px 16px" : "6px",
    border: failed
      ? "1px solid rgba(248, 113, 113, 0.72)"
      : "1px solid rgba(148, 163, 184, 0.48)",
    "border-radius": "14px",
    background: failed ? "rgb(45, 24, 27)" : "rgb(17, 24, 39)",
    color: failed ? "rgb(254, 202, 202)" : "rgb(241, 245, 249)",
    "font-family": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "font-size": failed ? "12px" : "11px",
    "font-weight": "600",
    "line-height": "1.35",
    "text-align": "center",
    "white-space": failed ? "normal" : "nowrap",
    "overflow-wrap": "anywhere",
    "box-shadow": "0 8px 28px rgba(15, 23, 42, 0.28)",
    "pointer-events": "none",
    "z-index": "1",
  });
  return style.cssText;
}

function normalizeStatusLabel(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized.length > 0 && normalized.length <= 80 ? normalized : fallback;
}

function formatFailurePhase(failure: InPageWidgetHostFailure): string {
  return failure.integrityIssue
    ? `${failure.phase}/${failure.integrityIssue}`
    : failure.phase;
}

function createFrameStyle(root: Document): string {
  const style = root.createElement("iframe").style;
  Object.assign(style, {
    all: "initial",
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    border: "0",
    borderRadius: "inherit",
    pointerEvents: "auto",
  });
  return style.cssText;
}

function hasExactAttributes(element: Element, expected: string[]): boolean {
  const actual = element.getAttributeNames().sort();
  return actual.length === expected.length &&
    expected.every((attribute, index) => attribute === actual[index]);
}

function inspectUnsafeFrameAttribute(
  frame: HTMLIFrameElement,
): InPageWidgetIntegrityIssue | null {
  for (const name of frame.getAttributeNames()) {
    if (name === "srcdoc") {
      return frame.getAttribute("srcdoc") === ""
        ? "frame-srcdoc-empty"
        : "frame-srcdoc-content";
    }
    if (name.startsWith("on")) return "frame-event-handler";
    if (name === "name") return "frame-name";
    if (name === "allowfullscreen" || name === "allowpaymentrequest" ||
        name === "browsingtopics") return "frame-permission-attribute";
    if (name === "credentialless" || name === "csp") return "frame-isolation-attribute";
    if (name === "autofocus") return "frame-focus-attribute";
    if (name === "exportparts" || name === "part" || name === "slot") {
      return "frame-projection-attribute";
    }
    if (name === "hidden" || name === "inert" || name === "popover") {
      return "frame-visibility-attribute";
    }
  }
  return null;
}

function setImportantProperties(
  style: CSSStyleDeclaration,
  properties: Record<string, string>,
): void {
  for (const [property, value] of Object.entries(properties)) {
    style.setProperty(property, value, "important");
  }
}

function matchesStyleContract(
  actual: CSSStyleDeclaration,
  expectedCssText: string,
  root: Document,
): boolean {
  const expected = root.createElement("div").style;
  expected.cssText = expectedCssText;
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const property = expected.item(index);
    if (
      actual.getPropertyValue(property) !== expected.getPropertyValue(property) ||
      actual.getPropertyPriority(property) !== expected.getPropertyPriority(property)
    ) return false;
  }
  return true;
}
