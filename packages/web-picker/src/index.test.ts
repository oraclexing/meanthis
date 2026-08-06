// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isUIAttachment } from "@meanthis/schema";
import {
  createUiAttachBookmarklet,
  createUiAttachInjectedRuntime,
  createUiAttachPicker,
} from "./index";

describe("createUiAttachPicker", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("selects the next surface element and opens a shadow composer", () => {
    const { button, surface } = mountFixture();
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    button.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].target).toBe(button);
    expect(onSelect.mock.calls[0][0].attachment.element.text).toBe("Save changes");
    expect(button.getAttribute("data-ui-attach-selected")).toBe("true");
    expect(getComposerShadow()?.querySelector("[data-ui-attach-composer]")).not.toBeNull();
    expect(getComposerShadow()?.querySelector("textarea")).toBe(getComposerShadow()?.activeElement);
  });

  it("blocks later delegated document handlers for an accepted picker click", () => {
    const { button, surface } = mountFixture();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      onSubmit: vi.fn(),
    });
    const pageAction = vi.fn();
    document.addEventListener("click", pageAction, { capture: true });

    picker.startComment();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    document.removeEventListener("click", pageAction, { capture: true });
    picker.destroy();
    expect(pageAction).not.toHaveBeenCalled();
  });

  it("selects the composed element inside an open shadow root", () => {
    document.body.innerHTML = '<section data-ui-attach-surface><div id="host"></div></section>';
    const surface = document.querySelector("[data-ui-attach-surface]");
    const host = document.querySelector("#host");
    if (!(surface instanceof HTMLElement) || !(host instanceof HTMLElement)) {
      throw new Error("shadow picker fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.dataset.testid = "shadow-save";
    button.textContent = "Save shadow changes";
    shadowRoot.append(button);
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].target).toBe(button);
    expect(onSelect.mock.calls[0][0].attachment.element.text).toBe("Save shadow changes");
    expect(button.getAttribute("data-ui-attach-selected")).toBe("true");
    expect(host.hasAttribute("data-ui-attach-selected")).toBe(false);
    picker.destroy();
  });

  it("passes disclosure mode to extracted attachments", () => {
    document.body.innerHTML = `
      <main>
        <section data-ui-attach-surface>
          <button data-testid="invite-button" type="button">Invite</button>
          <p>Contact ada@example.com with token sk-test-1234567890</p>
        </section>
      </main>
    `;
    const surface = document.querySelector("[data-ui-attach-surface]");
    const button = document.querySelector("[data-testid='invite-button']");
    if (!(surface instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 8,
        y: 16,
        width: 128,
        height: 40,
        top: 16,
        left: 8,
        right: 136,
        bottom: 56,
        toJSON: () => ({}),
      }) as DOMRect;
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      disclosureMode: "full_debug",
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    button.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].attachment.policy.disclosureMode).toBe("full_debug");
    expect(onSelect.mock.calls[0][0].attachment.context.nearbyText).toContain(
      "Contact ada@example.com with token sk-test-1234567890",
    );
  });

  it("exports user intent, attachment, and markdown when the composer is submitted", () => {
    const { button, surface } = mountFixture();
    const onSubmit = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      onSubmit,
    });

    picker.startComment();
    button.click();
    const shadow = getRequiredComposerShadow();
    const note = shadow.querySelector("textarea");
    const submit = shadow.querySelector("[data-ui-attach-submit]");
    if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      throw new Error("composer controls missing");
    }

    note.value = "Make this button calmer.";
    submit.click();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].target).toBe(button);
    expect(onSubmit.mock.calls[0][0].intent).toBe("Make this button calmer.");
    expect(onSubmit.mock.calls[0][0].attachment.context.selectorHints).toContain(
      "[data-testid=\"save-button\"]",
    );
    expect(onSubmit.mock.calls[0][0].markdown).toContain("## User Intent");
    expect(onSubmit.mock.calls[0][0].markdown).toContain("Make this button calmer.");
    expect(onSubmit.mock.calls[0][0].markdown).toContain("### Locator Bundle");
    expect(onSubmit.mock.calls[0][0].markdown).toContain("### Policy");
    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(shadow.querySelector("[data-ui-attach-composer]")).toBeNull();
  });

  it("ignores blank surface clicks while armed", () => {
    const { button, surface } = mountFixture();
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    surface.click();
    button.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].target).toBe(button);
  });

  it("cancels and destroys without leaving selection or picker UI behind", () => {
    const { button, surface } = mountFixture();
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface,
      onCancel,
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    button.click();
    picker.cancel();

    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(getComposerShadow()?.querySelector("[data-ui-attach-composer]")).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);

    picker.startComment();
    picker.destroy();
    button.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-ui-attach-picker-host]")).toBeNull();
  });

  it("selects a target from an iframe document root", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const root = iframe.contentDocument;
    const realm = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!root || !realm) {
      throw new Error("iframe realm missing");
    }
    root.title = "Inner frame";
    root.body.innerHTML = `
      <section data-ui-attach-surface>
        <label for="inner-email">Inner email</label>
        <input id="inner-email" type="email">
      </section>
    `;
    const target = root.querySelector("input");
    if (!target) {
      throw new Error("iframe target missing");
    }
    expect(target).not.toBeInstanceOf(HTMLElement);
    expect(target).toBeInstanceOf(realm.HTMLElement);
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root,
      surface: "[data-ui-attach-surface]",
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    target.dispatchEvent(new realm.MouseEvent("click", { bubbles: true }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].target).toBe(target);
    expect(onSelect.mock.calls[0][0].attachment.element.accessibleName).toBe("Inner email");
    expect(onSelect.mock.calls[0][0].attachment.source).toEqual({
      kind: "web",
      title: "Inner frame",
      url: "about:blank",
    });
    expect(root.querySelector("[data-ui-attach-picker-host]")?.shadowRoot).not.toBeNull();
    expect(document.querySelector("[data-ui-attach-picker-host]")).toBeNull();
    picker.destroy();
    iframe.remove();
  });

  it("does not drop the selection boundary for a foreign-root surface", () => {
    document.body.innerHTML = '<button type="button">Outside foreign surface</button>';
    const target = document.querySelector("button");
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignRoot = iframe.contentDocument;
    if (!target || !foreignRoot) {
      throw new Error("foreign surface fixture missing");
    }
    foreignRoot.body.innerHTML = "<section data-foreign-surface></section>";
    const foreignSurface = foreignRoot.querySelector("[data-foreign-surface]");
    if (!foreignSurface) {
      throw new Error("foreign surface missing");
    }
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({
      root: document,
      surface: foreignSurface as HTMLElement,
      onSelect,
      onSubmit: vi.fn(),
    });

    picker.startComment();
    target.click();

    expect(onSelect).not.toHaveBeenCalled();
    picker.destroy();
    iframe.remove();
  });

  it("selects a target from a detached alternate document", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const iframeDocument = iframe.contentDocument;
    const realm = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!iframeDocument || !realm) {
      throw new Error("iframe realm missing");
    }
    const root = iframeDocument.implementation.createHTMLDocument("Detached");
    root.body.innerHTML = '<button type="button">Pick detached</button>';
    const target = root.querySelector("button");
    if (!target) {
      throw new Error("detached target missing");
    }
    expect(root.defaultView).toBeNull();
    expect(target).not.toBeInstanceOf(HTMLElement);
    const onSelect = vi.fn();
    const picker = createUiAttachPicker({ root, onSelect, onSubmit: vi.fn() });

    picker.startComment();
    target.dispatchEvent(new realm.MouseEvent("click", { bubbles: true }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].target).toBe(target);
    expect(onSelect.mock.calls[0][0].attachment.source).toEqual({
      kind: "web",
      title: "Detached",
      url: "about:blank",
    });
    picker.destroy();
    iframe.remove();
  });
});

describe("createUiAttachInjectedRuntime", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("arms external capture and exports attachment JSON plus markdown", () => {
    const { button } = mountFixture();
    const pageClick = vi.fn();
    const onExport = vi.fn();
    const runtime = createUiAttachInjectedRuntime({
      root: document,
      onExport,
    });
    button.addEventListener("click", pageClick);

    button.click();
    expect(pageClick).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(0);

    runtime.arm();
    button.click();
    const shadow = getRequiredComposerShadow();
    const note = shadow.querySelector("textarea");
    const submit = shadow.querySelector("[data-ui-attach-submit]");
    if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      throw new Error("composer controls missing");
    }

    note.value = "Make this primary action calmer.";
    submit.click();

    expect(onExport).toHaveBeenCalledTimes(1);
    const exportedJson = JSON.parse(onExport.mock.calls[0][0].json) as unknown;
    expect(isUIAttachment(exportedJson)).toBe(true);
    expect(onExport.mock.calls[0][0].intent).toBe("Make this primary action calmer.");
    expect(onExport.mock.calls[0][0].attachment.element.text).toBe("Save changes");
    expect(onExport.mock.calls[0][0].json).toContain("\"schemaVersion\": \"0.3.0\"");
    expect(onExport.mock.calls[0][0].markdown).toContain("## User Intent");
    expect(onExport.mock.calls[0][0].markdown).toContain("### Policy");
    expect(onExport.mock.calls[0][0].attachment.locatorBundle.candidates.length).toBeGreaterThan(0);
    expect(onExport.mock.calls[0][0].attachment.policy.allowNetworkSend).toBe(false);
    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(shadow.querySelector("[data-ui-attach-composer]")).toBeNull();

    runtime.destroy();
  });

  it("cancels injected capture without exporting or leaving selection behind", () => {
    const { button } = mountFixture();
    const onCancel = vi.fn();
    const onExport = vi.fn();
    const runtime = createUiAttachInjectedRuntime({
      root: document,
      onCancel,
      onExport,
    });

    runtime.arm();
    button.click();
    runtime.cancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(0);
    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(getComposerShadow()?.querySelector("[data-ui-attach-composer]")).toBeNull();

    runtime.destroy();
  });

  it("does not select its own injected composer host", () => {
    const { button } = mountFixture();
    const onExport = vi.fn();
    const runtime = createUiAttachInjectedRuntime({
      root: document,
      onExport,
    });

    runtime.arm();
    button.click();
    const host = document.querySelector("[data-ui-attach-picker-host]");
    if (!(host instanceof HTMLElement)) {
      throw new Error("picker host missing");
    }

    runtime.arm();
    host.click();
    const shadow = getRequiredComposerShadow();
    const note = shadow.querySelector("textarea");
    const submit = shadow.querySelector("[data-ui-attach-submit]");
    if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      throw new Error("composer controls missing");
    }
    note.value = "Keep target anchored.";
    submit.click();

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport.mock.calls[0][0].target).toBe(button);

    runtime.destroy();
  });
});

describe("createUiAttachBookmarklet", () => {
  it("builds a one-click bookmarklet that imports the injected runtime and arms capture", () => {
    const href = createUiAttachBookmarklet({
      moduleUrl: "https://cdn.example.com/ui-attach-runtime.js",
    });
    const source = decodeBookmarklet(href);

    expect(href.startsWith("javascript:")).toBe(true);
    expect(source).toContain(
      'const moduleUrl = "https://cdn.example.com/ui-attach-runtime.js"',
    );
    expect(source).toContain("await import(moduleUrl)");
    expect(source).toContain("createUiAttachInjectedRuntime");
    expect(source).toContain("__uiAttachRuntime");
    expect(source).toContain("__uiAttachLastExport");
    expect(source).toContain("ui-attach:armed");
    expect(source).toContain("ui-attach:cancel");
    expect(source).toContain("ui-attach:export");
    expect(source).toContain("onCancel()");
    expect(source).toContain("showBookmarkletStatus()");
    expect(source).toContain("hideBookmarkletStatus()");
    expect(source).toContain("data-ui-attach-bookmarklet-status");
    expect(source).toContain("Click an element");
    expect(source).toContain("isSelectableTarget(target)");
    expect(source).toContain("runtime.arm()");
    expect(source).toContain("new CustomEvent(armedEventName)");
    expect(source).not.toContain("navigator.clipboard");
    expect(source).not.toContain("fetch(");
  });

  it("supports custom page keys and export event names", () => {
    const href = createUiAttachBookmarklet({
      moduleUrl: "http://127.0.0.1:5174/ui-attach-runtime.js",
      runtimeKey: "__customUiAttachRuntime",
      lastExportKey: "__customUiAttachExport",
      armedEventName: "custom-ui-attach:armed",
      cancelEventName: "custom-ui-attach:cancel",
      eventName: "custom-ui-attach:export",
    });
    const source = decodeBookmarklet(href);

    expect(source).toContain("\"__customUiAttachRuntime\"");
    expect(source).toContain("\"__customUiAttachExport\"");
    expect(source).toContain("\"custom-ui-attach:armed\"");
    expect(source).toContain("\"custom-ui-attach:cancel\"");
    expect(source).toContain("\"custom-ui-attach:export\"");
  });

  it("checks the page runtime shape before reusing an existing key", () => {
    const href = createUiAttachBookmarklet({
      moduleUrl: "https://cdn.example.com/ui-attach-runtime.js",
    });
    const source = decodeBookmarklet(href);

    expect(source).toContain("isUiAttachRuntime");
    expect(source).toContain("typeof candidate.arm === \"function\"");
    expect(source).toContain("typeof candidate.cancel === \"function\"");
    expect(source).toContain("typeof candidate.destroy === \"function\"");
  });

  it("recreates an existing page runtime when bookmarklet event configuration changes", () => {
    const href = createUiAttachBookmarklet({
      moduleUrl: "https://cdn.example.com/ui-attach-runtime.js",
    });
    const source = decodeBookmarklet(href);

    expect(source).toContain("runtimeConfigKey");
    expect(source).toContain("configSignature");
    expect(source).toContain("w[runtimeConfigKey] === configSignature");
    expect(source).toContain("existingRuntime.destroy()");
  });

  it("includes the module URL in the runtime reuse signature", () => {
    const href = createUiAttachBookmarklet({
      moduleUrl: "https://cdn.example.com/ui-attach-runtime.js?v=2",
    });
    const source = decodeBookmarklet(href);

    expect(source).toContain(
      'const moduleUrl = "https://cdn.example.com/ui-attach-runtime.js?v=2"',
    );
    expect(source).toContain(
      "JSON.stringify({ moduleUrl, lastExportKey, cancelEventName, eventName })",
    );
    expect(source).toContain("await import(moduleUrl)");
  });

  it("rejects unsafe module URL protocols", () => {
    expect(() =>
      createUiAttachBookmarklet({
        moduleUrl: "javascript:alert(1)",
      }),
    ).toThrow("moduleUrl");
  });
});

function mountFixture(): {
  button: HTMLButtonElement;
  surface: HTMLElement;
} {
  document.body.innerHTML = `
    <main>
      <section data-ui-attach-surface>
        <h1>Profile settings</h1>
        <button data-testid="save-button" type="button">Save changes</button>
        <button type="button">Cancel</button>
      </section>
      <aside>
        <button type="button">Outside tool</button>
      </aside>
    </main>
  `;
  const surface = document.querySelector("[data-ui-attach-surface]");
  const button = document.querySelector("[data-testid='save-button']");
  if (!(surface instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    throw new Error("fixture missing");
  }
  button.getBoundingClientRect = () =>
    ({
      x: 8,
      y: 16,
      width: 128,
      height: 40,
      top: 16,
      left: 8,
      right: 136,
      bottom: 56,
      toJSON: () => ({}),
    }) as DOMRect;

  return { button, surface };
}

function getComposerShadow(): ShadowRoot | null {
  return document.querySelector<HTMLElement>("[data-ui-attach-picker-host]")?.shadowRoot ?? null;
}

function getRequiredComposerShadow(): ShadowRoot {
  const shadow = getComposerShadow();
  if (!shadow) {
    throw new Error("composer shadow root missing");
  }
  return shadow;
}

function decodeBookmarklet(href: string): string {
  return decodeURIComponent(href.slice("javascript:".length));
}
