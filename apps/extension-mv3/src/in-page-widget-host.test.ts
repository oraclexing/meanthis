// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  IN_PAGE_WIDGET_LAYER,
  IN_PAGE_WIDGET_CONNECT,
  createInPageWidgetHost,
} from "./in-page-widget-host";
import { createInPageWidgetInitMessage } from "./in-page-widget-contract";

const HOST_SELECTOR = "[data-ui-attach-in-page-widget-host]";

describe("createInPageWidgetHost", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll(HOST_SELECTOR).forEach((element) => element.remove());
    document.body.replaceChildren();
  });

  test("creates one isolated top-document extension iframe and removes a stale orphan", () => {
    const staleHost = document.createElement("div");
    staleHost.dataset.uiAttachInPageWidgetHost = "true";
    document.documentElement.append(staleHost);
    const unrelated = document.createElement("div");
    unrelated.id = "ui-attach-in-page-widget-host";
    document.body.append(unrelated);
    const createFrameUrl = vi.fn(() => "chrome-extension://extension-id/widget.html");

    const controller = createInPageWidgetHost({
      document,
      window,
      createFrameUrl,
    });

    const hosts = document.querySelectorAll(HOST_SELECTOR);
    expect(staleHost.isConnected).toBe(false);
    expect(unrelated.isConnected).toBe(true);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toBe(controller.element);
    expect(controller.element.parentElement).toBe(document.documentElement);
    expect(controller.element.dataset.uiAttachIgnore).toBe("true");
    expect(controller.element.style.all).toBe("initial");
    expect(controller.element.style.position).toBe("fixed");
    expect(controller.element.style.pointerEvents).toBe("none");
    expect(controller.element.style.opacity).toBe("1");
    expect(controller.element.style.width).toBe("144px");
    expect(controller.element.style.zIndex).toBe(String(IN_PAGE_WIDGET_LAYER));
    expect(controller.element.shadowRoot).toBeNull();
    expect(controller.element.childNodes).toHaveLength(0);

    expect(controller.frame.getAttribute("data-meanthis-widget-frame")).toBe("");
    expect(controller.frame.title).toBe("MeanThis");
    expect(controller.frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(controller.frame.getAttribute("allow")).toBe("clipboard-write");
    expect(controller.frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(controller.frame.getAttribute("src")).toBe(
      "chrome-extension://extension-id/widget.html",
    );
    expect(controller.frame.style.pointerEvents).toBe("auto");
    expect(controller.frame.style.colorScheme).toBe("dark");
    expect(controller.frame.style.backgroundColor).toBe("transparent");
    expect(controller.element.style.colorScheme).toBe("dark");
    expect(controller.frame.parentNode?.textContent).toContain("MeanThis is starting");
    expect(createFrameUrl).toHaveBeenCalledTimes(1);
    expect(controller.element.outerHTML).not.toContain("task");
    expect(controller.element.outerHTML).not.toContain("token");

    controller.dispose();
  });

  test("shows, hides, focuses, and positions inside responsive safe-area bounds", () => {
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
    });
    const focus = vi.spyOn(controller.frame, "focus");

    expect(controller.element.style.display).toBe("block");
    expect(controller.element.style.width).toBe("144px");
    expect(controller.element.style.height).toBe("52px");
    expect(controller.element.style.right).toContain("20px");
    expect(controller.element.style.right).toContain("safe-area-inset-right");
    expect(controller.element.style.bottom).toContain("20px");
    expect(controller.element.style.bottom).toContain("safe-area-inset-bottom");
    expect(controller.element.style.left).toBe("auto");
    expect(controller.element.style.maxWidth).toContain("100vw - 40px");
    expect(controller.element.style.maxWidth).toContain("safe-area-inset-left");
    expect(controller.element.style.maxWidth).toContain("safe-area-inset-right");
    expect(controller.element.style.maxHeight).toContain("safe-area-inset-top");
    expect(controller.element.style.maxHeight).toContain("safe-area-inset-bottom");

    controller.hide();
    expect(controller.element.style.display).toBe("none");
    controller.focus();
    expect(focus).not.toHaveBeenCalled();

    controller.show();
    controller.setPosition("bottom-left");
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    controller.focus();
    expect(controller.element.style.left).toContain("safe-area-inset-left");
    expect(controller.element.style.right).toBe("auto");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    controller.dispose();
  });

  test("keeps the light-DOM host above hostile page important styles", () => {
    const hostileStyle = document.createElement("style");
    hostileStyle.textContent = `
      * {
        display: none !important;
        position: static !important;
        width: 1px !important;
        height: 1px !important;
        pointer-events: none !important;
        z-index: -1 !important;
      }
    `;
    document.head.append(hostileStyle);

    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
    });
    let computed = window.getComputedStyle(controller.element);

    expect(computed.display).toBe("block");
    expect(computed.position).toBe("fixed");
    expect(computed.width).toBe("144px");
    expect(computed.height).toBe("52px");
    expect(computed.pointerEvents).toBe("none");
    expect(computed.zIndex).toBe(String(IN_PAGE_WIDGET_LAYER));
    expect(controller.element.style.getPropertyPriority("all")).toBe("important");
    expect(controller.element.style.getPropertyPriority("pointer-events")).toBe("important");

    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    computed = window.getComputedStyle(controller.element);
    expect(computed.pointerEvents).toBe("auto");
    expect(computed.opacity).toBe("1");

    controller.dispose();
    hostileStyle.remove();
  });

  test("replaces the active controller instead of creating duplicate hosts", () => {
    const first = createHost();
    const second = createHost();

    expect(first.element.isConnected).toBe(false);
    expect(second.element.isConnected).toBe(true);
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);

    first.show();
    expect(first.element.isConnected).toBe(false);
    second.dispose();
  });

  test.each([
    "chrome-extension://extension-id/widget.html?lease=secret",
    "chrome-extension://extension-id/widget.html#session-secret",
    "chrome-extension://user:secret@extension-id/widget.html",
    "chrome-extension://extension-id/private/secret-token",
    "chrome-extension://extension-id/in-page-widget.html",
    "https://example.test/widget.html",
  ])("rejects a non-parameterless extension URL: %s", (frameUrl) => {
    expect(() => createHost({ createFrameUrl: () => frameUrl })).toThrow(
      /parameterless extension URL/i,
    );
    expect(document.querySelector(HOST_SELECTOR)).toBeNull();
  });

  test("repairs host and frame tampering without storing attacker data", async () => {
    const controller = createHost({ maxTamperRepairs: 2 });
    const shadow = controller.frame.parentNode;
    if (!(shadow instanceof ShadowRoot)) throw new Error("widget shadow root missing");

    controller.element.removeAttribute("data-ui-attach-ignore");
    controller.element.setAttribute("data-task", "private task text");
    controller.element.style.zIndex = "1";
    controller.element.append(document.createTextNode("private task text"));
    controller.frame.src = "https://attacker.example/widget?token=secret";
    controller.frame.removeAttribute("sandbox");
    shadow.removeChild(controller.frame);
    await flushMutations();

    expect(controller.element.dataset.uiAttachIgnore).toBe("true");
    expect(controller.element.hasAttribute("data-task")).toBe(false);
    expect(controller.element.style.zIndex).toBe(String(IN_PAGE_WIDGET_LAYER));
    expect(controller.element.childNodes).toHaveLength(0);
    expect(controller.frame.parentNode).toBe(shadow);
    expect(controller.frame.getAttribute("src")).toBe(
      "chrome-extension://extension-id/widget.html",
    );
    expect(controller.frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(controller.frame.getAttribute("allow")).toBe("clipboard-write");

    controller.dispose();
  });

  test("allows inert browser frame metadata but removes active iframe attributes", async () => {
    const controller = createHost({ maxTamperRepairs: 2 });

    controller.frame.setAttribute("data-browser-frame-id", "opaque-1");
    await flushMutations();
    expect(controller.element.isConnected).toBe(true);
    expect(controller.frame.getAttribute("data-browser-frame-id")).toBe("opaque-1");

    controller.frame.setAttribute("srcdoc", "<script>top.location='https://attacker.example'</script>");
    await flushMutations();
    expect(controller.element.isConnected).toBe(true);
    expect(controller.frame.hasAttribute("srcdoc")).toBe(false);
    expect(controller.frame.getAttribute("src")).toBe(
      "chrome-extension://extension-id/widget.html",
    );

    controller.dispose();
  });

  test("removes an empty browser srcdoc placeholder without restarting the configured src", async () => {
    const onFailure = vi.fn();
    const controller = createHost({ maxTamperRepairs: 1, onFailure });
    const source = controller.frame.getAttribute("src");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      controller.frame.setAttribute("srcdoc", "");
      await flushMutations();

      expect(controller.element.isConnected).toBe(true);
      expect(controller.frame.hasAttribute("srcdoc")).toBe(false);
      expect(controller.frame.getAttribute("src")).toBe(source);
    }
    expect(onFailure).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("waits for the extension document after an inherited-page load before delivering the private channel", async () => {
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const createMessageChannel = vi.fn(() => channel.value);
    const postFrameMessage = vi.fn(() => true);
    let frameDocument: Document | null = document;
    const controller = createHost({
      createMessageChannel,
      postFrameMessage,
      getFrameDocument: () => frameDocument,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    controller.frame.setAttribute("srcdoc", "");
    await flushMutations();
    controller.frame.dispatchEvent(new Event("load"));

    expect(controller.frame.hasAttribute("srcdoc")).toBe(false);
    expect(createMessageChannel).not.toHaveBeenCalled();
    expect(postFrameMessage).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(controller.element.isConnected).toBe(true);

    frameDocument = null;
    controller.frame.dispatchEvent(new Event("load"));

    expect(createMessageChannel).toHaveBeenCalledTimes(1);
    expect(postFrameMessage).toHaveBeenCalledWith(
      controller.frame,
      { type: IN_PAGE_WIDGET_CONNECT },
      "chrome-extension://extension-id",
      [channel.port2],
    );
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    await expect(controller.waitUntilReady()).resolves.toEqual({ ready: true });
    controller.dispose();
  });

  test("rechecks the frame document when initialization arrives after an earlier valid load", async () => {
    const channel = createFakeChannel();
    const createMessageChannel = vi.fn(() => channel.value);
    const postFrameMessage = vi.fn(() => true);
    let frameDocument: Document | null = null;
    const controller = createHost({
      createMessageChannel,
      postFrameMessage,
      getFrameDocument: () => frameDocument,
    });

    controller.frame.dispatchEvent(new Event("load"));
    frameDocument = document;
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    expect(createMessageChannel).not.toHaveBeenCalled();
    expect(postFrameMessage).not.toHaveBeenCalled();

    frameDocument = null;
    controller.frame.dispatchEvent(new Event("load"));

    expect(createMessageChannel).toHaveBeenCalledTimes(1);
    expect(postFrameMessage).toHaveBeenCalledTimes(1);
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    await expect(controller.waitUntilReady()).resolves.toEqual({ ready: true });
    controller.dispose();
  });

  test("reports an active iframe attribute without reflecting its value", async () => {
    const onFailure = vi.fn();
    const controller = createHost({ maxTamperRepairs: 0, onFailure });

    controller.frame.setAttribute("srcdoc", "<p>private page text</p>");
    await flushMutations();

    expect(onFailure).toHaveBeenCalledWith({
      code: "TAMPER_REPAIR_LIMIT_REACHED",
      integrityIssue: "frame-srcdoc-content",
      phase: "frame-loading",
      repairs: 0,
    });
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("private page text");
  });

  test("keeps one private port and accepts only exact bounded layout messages", () => {
    const channel = createFakeChannel();
    const createMessageChannel = vi.fn(() => channel.value);
    const postFrameMessage = vi.fn(() => true);
    const controller = createHost({ createMessageChannel, postFrameMessage });
    const init = createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    );

    expect(controller.initialize(init)).toBe(true);
    init.capability = "B".repeat(43);
    expect(postFrameMessage).not.toHaveBeenCalled();

    controller.frame.dispatchEvent(new Event("load"));

    expect(postFrameMessage).toHaveBeenCalledTimes(1);
    expect(postFrameMessage).toHaveBeenCalledWith(
      controller.frame,
      { type: IN_PAGE_WIDGET_CONNECT },
      "chrome-extension://extension-id",
      [channel.port2],
    );
    expect(channel.port1.postMessage).toHaveBeenCalledWith({
      type: "ui-attach:in-page-widget-init",
      schemaVersion: "1",
      surfaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capability: "A".repeat(43),
    });
    expect(channel.port1.start).toHaveBeenCalledTimes(1);
    expect(channel.port1.close).not.toHaveBeenCalled();
    expect(controller.element.outerHTML).not.toContain("A".repeat(43));
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    expect(controller.initialize(createInPageWidgetInitMessage(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "C".repeat(43),
    ))).toBe(false);

    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    expect(controller.element.style.pointerEvents).toBe("auto");
    expect(controller.element.style.opacity).toBe("1");
    expect(controller.element.style.width).toBe("48px");
    expect(controller.element.style.height).toBe("48px");
    expect(controller.element.style.borderRadius).toBe("999px");
    expect(controller.element.style.transition).toContain("width 170ms");
    channel.emit({ type: "meanthis.widget.layout", mode: "expanded" });
    expect(controller.element.style.width).toBe("360px");
    expect(controller.element.style.height).toBe("560px");

    channel.emit({ type: "meanthis.widget.layout", mode: "workbar", width: 209 });
    expect(controller.element.style.width).toBe("209px");
    channel.emit({ type: "meanthis.widget.layout", mode: "workbar", width: 199 });
    channel.emit({ type: "meanthis.widget.layout", mode: "scope", width: 239, height: 224 });
    expect(controller.element.style.width).toBe("209px");
    channel.emit({ type: "meanthis.widget.layout", mode: "workbar", width: 292 });
    expect(controller.element.style.width).toBe("292px");
    expect(controller.element.style.height).toBe("64px");
    expect(controller.element.style.borderRadius).toBe("999px");
    expect(controller.element.style.boxShadow).toContain("0 14px 34px");

    channel.emit({ type: "meanthis.widget.layout", mode: "scope", width: 360, height: 224 });
    expect(controller.element.style.width).toBe("360px");
    expect(controller.element.style.height).toBe("224px");
    expect(controller.element.style.borderRadius).toBe("18px");
    expect(controller.element.style.boxShadow).toBe("none");

    channel.emit({ type: "meanthis.widget.layout", mode: "workbar" });
    channel.emit({ type: "meanthis.widget.layout", mode: "workbar", width: 999 });
    channel.emit({ type: "meanthis.widget.layout", mode: "scope", width: 360, height: 127 });
    channel.emit({ type: "meanthis.widget.layout", mode: "scope", width: 360 });
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed", extra: true });
    channel.emit({ type: "meanthis.widget.layout", mode: "full-screen" });
    channel.emit({ type: "meanthis.widget.unknown", mode: "collapsed" });
    channel.emit("collapsed");
    expect(controller.element.style.width).toBe("360px");
    expect(controller.element.style.height).toBe("224px");

    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    expect(controller.element.style.width).toBe("48px");
    expect(controller.element.style.height).toBe("48px");

    controller.frame.dispatchEvent(new Event("load"));
    expect(postFrameMessage).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port1.onmessage).toBeNull();
    expect(channel.port1.onmessageerror).toBeNull();
  });

  test("fails closed when unknown private messages never acknowledge the handshake", () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    const shadow = controller.frame.parentNode;
    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed", extra: true });
    channel.emit({ type: "meanthis.widget.unknown", mode: "collapsed" });

    vi.advanceTimersByTime(50);

    expect(controller.element.isConnected).toBe(true);
    expect(controller.frame.isConnected).toBe(false);
    expect(controller.element.style.width).toBe("320px");
    expect(shadow?.textContent).toContain(
      "MeanThis could not start \u00b7 initialization-delivered",
    );
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      code: "PRIVATE_HANDSHAKE_TIMEOUT",
      phase: "initialization-delivered",
      repairs: 0,
    });
  });

  test("starts the handshake timeout only after delivery, not during frame loading", () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(controller.element.isConnected).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();

    controller.frame.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(49);
    expect(controller.element.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(onFailure).toHaveBeenCalledWith({
      code: "PRIVATE_HANDSHAKE_TIMEOUT",
      phase: "initialization-delivered",
      repairs: 0,
    });
  });

  test("fails closed when the frame never reaches the extension document", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const controller = createHost({
      readyTimeoutMs: 50,
      getFrameDocument: () => document,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    const readiness = controller.waitUntilReady();
    controller.frame.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(49);
    expect(onFailure).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    await expect(readiness).resolves.toEqual({
      ready: false,
      failure: {
        code: "READY_TIMEOUT",
        phase: "frame-loading",
        repairs: 0,
      },
    });
    expect(controller.frame.isConnected).toBe(false);
    expect(onFailure).toHaveBeenCalledWith({
      code: "READY_TIMEOUT",
      phase: "frame-loading",
      repairs: 0,
    });
  });

  test("clears the total readiness timeout after the private handshake succeeds", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      readyTimeoutMs: 50,
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    await expect(controller.waitUntilReady()).resolves.toEqual({ ready: true });

    vi.advanceTimersByTime(50);

    expect(onFailure).not.toHaveBeenCalled();
    expect(controller.frame.isConnected).toBe(true);
    controller.dispose();
  });

  test("clears the total readiness timeout when disposed before the frame loads", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const controller = createHost({
      readyTimeoutMs: 50,
      getFrameDocument: () => document,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    const readiness = controller.waitUntilReady();
    controller.dispose();
    vi.advanceTimersByTime(50);

    await expect(readiness).resolves.toEqual({
      ready: false,
      failure: {
        code: "DISPOSED",
        phase: "frame-loading",
        repairs: 0,
      },
    });
    expect(onFailure).not.toHaveBeenCalled();
  });

  test("reports readiness only after the authenticated layout acknowledgement", async () => {
    vi.useFakeTimers();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    let settled = false;
    const readiness = controller.waitUntilReady().then((value) => {
      settled = true;
      return value;
    });
    controller.frame.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(settled).toBe(false);

    channel.emit({ type: "meanthis.widget.phase", phase: "lifecycle-ready" });
    await Promise.resolve();
    expect(settled).toBe(false);

    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    await expect(readiness).resolves.toEqual({ ready: true });
  });

  test("grants one bounded hydration window after the lifecycle becomes authenticated", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    controller.frame.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(49);
    channel.emit({ type: "meanthis.widget.phase", phase: "lifecycle-ready" });
    vi.advanceTimersByTime(49);

    expect(onFailure).not.toHaveBeenCalled();
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    await expect(controller.waitUntilReady()).resolves.toEqual({ ready: true });
  });

  test("does not let repeated lifecycle phases extend hydration indefinitely", () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    controller.frame.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(49);
    channel.emit({ type: "meanthis.widget.phase", phase: "lifecycle-ready" });
    vi.advanceTimersByTime(49);
    channel.emit({ type: "meanthis.widget.phase", phase: "lifecycle-ready" });
    vi.advanceTimersByTime(1);

    expect(onFailure).toHaveBeenCalledWith({
      code: "PRIVATE_HANDSHAKE_TIMEOUT",
      phase: "lifecycle-ready",
      repairs: 0,
    });
  });

  test("fails immediately when the authenticated UI reports terminal initialization failure", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);

    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.phase", phase: "lifecycle-ready" });
    channel.emit({ type: "meanthis.widget.phase", phase: "authenticated-ui-failed" });

    await expect(controller.waitUntilReady()).resolves.toEqual({
      ready: false,
      failure: {
        code: "PRIVATE_INITIALIZATION_FAILED",
        phase: "authenticated-ui-failed",
        repairs: 0,
      },
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test("returns a bounded phase when readiness fails before layout acknowledgement", async () => {
    vi.useFakeTimers();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      privateHandshakeTimeoutMs: 50,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.phase", phase: "runtime-register-ok" });

    const readiness = controller.waitUntilReady();
    vi.advanceTimersByTime(50);
    await expect(readiness).resolves.toEqual({
      ready: false,
      failure: {
        code: "PRIVATE_HANDSHAKE_TIMEOUT",
        phase: "runtime-register-ok",
        repairs: 0,
      },
    });
  });

  test("rejects invalid initialization without creating a private channel", () => {
    const createMessageChannel = vi.fn();
    const controller = createHost({ createMessageChannel });

    expect(controller.initialize({
      type: "ui-attach:in-page-widget-init",
      schemaVersion: "1",
      surfaceId: "not-a-uuid",
      capability: "secret",
    })).toBe(false);
    controller.frame.dispatchEvent(new Event("load"));
    expect(createMessageChannel).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("fails closed if the private channel cannot be delivered", () => {
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => false,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    const shadow = controller.frame.parentNode;

    controller.frame.dispatchEvent(new Event("load"));

    expect(controller.element.isConnected).toBe(true);
    expect(controller.frame.isConnected).toBe(false);
    expect(shadow?.textContent).toContain(
      "MeanThis could not start \u00b7 frame-loaded",
    );
    expect(onFailure).toHaveBeenCalledWith({
      code: "PRIVATE_INITIALIZATION_FAILED",
      phase: "frame-loaded",
      repairs: 0,
    });
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
  });

  test("closes the old port and re-establishes a private channel after frame repair", async () => {
    const first = createFakeChannel();
    const second = createFakeChannel();
    const createMessageChannel = vi.fn()
      .mockReturnValueOnce(first.value)
      .mockReturnValueOnce(second.value);
    const postFrameMessage = vi.fn(() => true);
    const controller = createHost({ createMessageChannel, postFrameMessage });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    first.emit({ type: "meanthis.widget.layout", mode: "expanded" });
    expect(controller.element.style.width).toBe("360px");

    controller.frame.setAttribute("src", "https://attacker.example/?token=secret");
    await flushMutations();

    expect(first.port1.close).toHaveBeenCalledTimes(1);
    expect(first.port1.onmessage).toBeNull();
    expect(controller.frame.getAttribute("src")).toBe(
      "chrome-extension://extension-id/widget.html",
    );
    expect(postFrameMessage).toHaveBeenCalledTimes(1);
    controller.frame.dispatchEvent(new Event("load"));
    expect(postFrameMessage).toHaveBeenCalledTimes(2);
    expect(second.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      capability: "A".repeat(43),
    }));
    expect(controller.element.outerHTML).not.toContain("A".repeat(43));

    second.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    expect(controller.element.style.width).toBe("48px");
    controller.dispose();
    expect(second.port1.close).toHaveBeenCalledTimes(1);
  });

  test("re-establishes the channel after an unexpected frame load", () => {
    const first = createFakeChannel();
    const second = createFakeChannel();
    const createMessageChannel = vi.fn()
      .mockReturnValueOnce(first.value)
      .mockReturnValueOnce(second.value);
    const postFrameMessage = vi.fn(() => true);
    const controller = createHost({ createMessageChannel, postFrameMessage });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    first.emit({ type: "meanthis.widget.layout", mode: "collapsed" });

    controller.frame.dispatchEvent(new Event("load"));
    expect(first.port1.close).toHaveBeenCalledTimes(1);
    expect(postFrameMessage).toHaveBeenCalledTimes(1);

    controller.frame.dispatchEvent(new Event("load"));
    expect(postFrameMessage).toHaveBeenCalledTimes(2);
    second.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    controller.dispose();
    expect(second.port1.close).toHaveBeenCalledTimes(1);
  });

  test("closes the channel before restoring an initialized detached host", async () => {
    const first = createFakeChannel();
    const second = createFakeChannel();
    const createMessageChannel = vi.fn()
      .mockReturnValueOnce(first.value)
      .mockReturnValueOnce(second.value);
    const postFrameMessage = vi.fn(() => true);
    const controller = createHost({ createMessageChannel, postFrameMessage });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    first.emit({ type: "meanthis.widget.layout", mode: "collapsed" });

    controller.element.remove();
    await flushMutations();
    expect(controller.element.isConnected).toBe(true);
    expect(first.port1.close).toHaveBeenCalledTimes(1);
    expect(postFrameMessage).toHaveBeenCalledTimes(1);

    controller.frame.dispatchEvent(new Event("load"));
    expect(postFrameMessage).toHaveBeenCalledTimes(2);
    second.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    controller.dispose();
  });

  test("recovers a same-task remove and reinsert that ends structurally intact", async () => {
    const first = createFakeChannel();
    const second = createFakeChannel();
    const createMessageChannel = vi.fn()
      .mockReturnValueOnce(first.value)
      .mockReturnValueOnce(second.value);
    const postFrameMessage = vi.fn(() => true);
    const controller = createHost({ createMessageChannel, postFrameMessage });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    first.emit({ type: "meanthis.widget.layout", mode: "collapsed" });

    controller.element.remove();
    document.documentElement.append(controller.element);
    await flushMutations();

    expect(controller.element.isConnected).toBe(true);
    expect(first.port1.close).toHaveBeenCalledTimes(1);
    controller.frame.dispatchEvent(new Event("load"));
    expect(postFrameMessage).toHaveBeenCalledTimes(2);
    second.emit({ type: "meanthis.widget.layout", mode: "collapsed" });
    controller.dispose();
  });

  test("closes an acknowledged port when tamper repair is not allowed", async () => {
    const onFailure = vi.fn();
    const channel = createFakeChannel();
    const controller = createHost({
      createMessageChannel: () => channel.value,
      postFrameMessage: () => true,
      maxTamperRepairs: 0,
      onFailure,
    });
    expect(controller.initialize(createInPageWidgetInitMessage(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "A".repeat(43),
    ))).toBe(true);
    controller.frame.dispatchEvent(new Event("load"));
    channel.emit({ type: "meanthis.widget.layout", mode: "collapsed" });

    controller.element.remove();
    await flushMutations();

    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      code: "TAMPER_REPAIR_LIMIT_REACHED",
      integrityIssue: "host-parent",
      phase: "layout-ack",
      repairs: 0,
    });
  });

  test("bounds host reinsertion and fails closed after the repair budget", async () => {
    const onFailure = vi.fn();
    const createFrameUrl = vi.fn(() => "chrome-extension://extension-id/widget.html");
    const controller = createHost({
      createFrameUrl,
      maxTamperRepairs: 1,
      onFailure,
    });

    controller.element.remove();
    await flushMutations();
    expect(controller.element.isConnected).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();

    controller.element.remove();
    await flushMutations();
    expect(controller.element.isConnected).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      code: "TAMPER_REPAIR_LIMIT_REACHED",
      integrityIssue: "host-parent",
      phase: "frame-loading",
      repairs: 1,
    });
    expect(createFrameUrl).toHaveBeenCalledTimes(1);

    controller.show();
    controller.element.remove();
    await flushMutations();
    expect(controller.element.isConnected).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test("dispose is idempotent and never lets the observer restore the host", async () => {
    const controller = createHost();

    controller.dispose();
    controller.dispose();
    await flushMutations();

    expect(controller.element.isConnected).toBe(false);
    controller.show();
    expect(controller.element.isConnected).toBe(false);
  });
});

function createHost(
  overrides: Partial<Parameters<typeof createInPageWidgetHost>[0]> = {},
) {
  return createInPageWidgetHost({
    document,
    window,
    createFrameUrl: () => "chrome-extension://extension-id/widget.html",
    // jsdom does not navigate the iframe to the configured extension URL.
    getFrameDocument: () => null,
    ...overrides,
  });
}

function createFakeChannel() {
  const port1 = {
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn(),
    start: vi.fn(),
  };
  const port2 = {
    close: vi.fn(),
  };
  return {
    value: { port1, port2 } as unknown as MessageChannel,
    port1,
    port2,
    emit(data: unknown) {
      port1.onmessage?.({ data } as MessageEvent<unknown>);
    },
  };
}

async function flushMutations(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}
