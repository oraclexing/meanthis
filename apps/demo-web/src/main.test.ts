// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { attachDemoSelection } from "./main";

describe("comment-flow demo", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("keeps the standalone picker flow as the default demo mode", () => {
    const { button, commentAction, extensionGuide, outputRegion, standaloneTools } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();

    expect(standaloneTools.hidden).toBe(false);
    expect(outputRegion.hidden).toBe(false);
    expect(extensionGuide.hidden).toBe(true);
    expect(getPickerShadow()).not.toBeNull();
  });

  it("shows only page targets and side-panel guidance in extension target mode", () => {
    window.history.replaceState({}, "", "/?ui-attach-demo=extension-target");
    const {
      bookmarkletLink,
      button,
      commentAction,
      extensionGuide,
      outputRegion,
      standaloneTools,
      surface,
    } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();

    expect(document.body.dataset.uiAttachDemoMode).toBe("extension-target");
    expect(standaloneTools.hidden).toBe(true);
    expect(outputRegion.hidden).toBe(true);
    expect(extensionGuide.hidden).toBe(false);
    expect(extensionGuide.textContent).toContain("Choose Add elements in MeanThis");
    expect(surface.hidden).toBe(false);
    expect(button.hidden).toBe(false);
    expect(bookmarkletLink.getAttribute("href")).toBe("#");
    expect(getPickerShadow()).toBeNull();
    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
  });

  it("fails closed to the standalone demo for unknown mode values", () => {
    window.history.replaceState({}, "", "/?ui-attach-demo=unexpected");
    const { button, commentAction, extensionGuide, outputRegion, standaloneTools } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();

    expect(document.body.dataset.uiAttachDemoMode).toBe("standalone");
    expect(standaloneTools.hidden).toBe(false);
    expect(outputRegion.hidden).toBe(false);
    expect(extensionGuide.hidden).toBe(true);
    expect(getPickerShadow()).not.toBeNull();
  });

  it("does not select an element before comment flow is armed", () => {
    const { button, output } = mountFixture();

    attachDemoSelection(document);
    button.click();

    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(output.textContent).toBe("");
  });

  it("selects the next clicked element after the comment action is armed", () => {
    const { button, commentAction, preview } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();

    expect(commentAction.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-ui-attach-selected")).toBe("true");
    const note = getPickerShadow()?.querySelector("textarea");
    expect(getPickerShadow()?.querySelector("[data-ui-attach-composer]")).not.toBeNull();
    expect(note.value).toBe("");
    const visualPreview = preview.querySelector("[data-ui-attach-preview-visual]");
    expect(visualPreview?.textContent).toContain("Save changes");
    expect(visualPreview?.getAttribute("data-ui-attach-preview-row")).toBeNull();
    expect(preview.querySelectorAll("[data-ui-attach-preview-row='true']")).toHaveLength(5);
    expect(preview.textContent).toContain("x=4 y=8 width=120 height=36");
  });

  it("shows replay verification and exports the replayed attachment", async () => {
    const { button, commentAction, output, preview } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();
    await flushAsyncWork();

    const replayStatus = preview.querySelector("[data-ui-attach-replay-status]");
    const replayAttempts = preview.querySelectorAll("[data-ui-attach-replay-attempt]");
    expect(replayStatus?.textContent).toContain("Replay verified");
    expect(replayStatus?.textContent).toContain("playwright.role");
    expect(replayAttempts).toHaveLength(1);

    const submit = getPickerShadow()?.querySelector("[data-ui-attach-submit]");
    if (!(submit instanceof HTMLButtonElement)) {
      throw new Error("composer submit missing");
    }
    submit.click();

    expect(output.textContent).toContain("- Replay Verified: true");
    expect(output.textContent).toContain("- Uniqueness: true");
  });

  it("exports user intent plus the selected element attachment", () => {
    const { button, commentAction, output } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();
    const note = getPickerShadow()?.querySelector("textarea");
    const submit = getPickerShadow()?.querySelector("[data-ui-attach-submit]");
    if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      throw new Error("composer controls missing");
    }
    note.value = "Make this button less visually dominant.";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    submit.click();

    expect(output.textContent).toContain("## User Intent");
    expect(output.textContent).toContain("Make this button less visually dominant.");
    expect(output.textContent).toContain("## Selected UI Element");
    expect(output.textContent).toContain("- Text: Save changes");
    expect(output.textContent).toContain("[data-testid=\"save-button\"]");
  });

  it("exports a labeled multi-attachment bundle for relational UI edits", () => {
    const { button, bundleAction, bundleList, cancelButton, output } = mountFixture();

    attachDemoSelection(document);
    bundleAction.click();
    button.click();
    submitActiveComposer("");

    bundleAction.click();
    cancelButton.click();
    submitActiveComposer("Move A below B.");

    expect(bundleList.textContent).toContain("A");
    expect(bundleList.textContent).toContain("Save changes");
    expect(bundleList.textContent).toContain("B");
    expect(bundleList.textContent).toContain("Cancel");
    expect(output.textContent).toContain("## User Intent");
    expect(output.textContent).toContain("Move A below B.");
    expect(output.textContent).toContain("## Attachment Map");
    expect(output.textContent).toContain('- A (`att_save-button`): button "Save changes"');
    expect(output.textContent).toContain('- B (`att_cancel-button`): button "Cancel"');
    expect(output.textContent).toContain("## Attachment A (`att_save-button`)");
    expect(output.textContent).toContain("## Attachment B (`att_cancel-button`)");
    expect(output.textContent).not.toContain("MeanThis HTML Block Move Packet");
    expect(output.textContent).not.toContain("Materialized Diff");
  });

  it("keeps comment, bundle, and injected runtime arm states mutually exclusive", () => {
    const { bundleAction, commentAction, injectedAction } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    expect(commentAction.getAttribute("aria-pressed")).toBe("true");

    bundleAction.click();
    expect(commentAction.getAttribute("aria-pressed")).toBe("false");
    expect(bundleAction.getAttribute("aria-pressed")).toBe("true");

    injectedAction.click();
    expect(bundleAction.getAttribute("aria-pressed")).toBe("false");
    expect(injectedAction.getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores blank container clicks while armed", () => {
    const { commentAction, surface, output } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    surface.click();

    expect(commentAction.getAttribute("aria-pressed")).toBe("true");
    expect(output.textContent).toBe("");
  });

  it("does not use right-click as the primary selection flow", () => {
    const { button, output } = mountFixture();

    attachDemoSelection(document);
    const allowed = button.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );

    expect(allowed).toBe(true);
    expect(output.textContent).toBe("");
    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
  });

  it("moves selection when a second comment target is chosen", () => {
    const { button, cancelButton, commentAction } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    button.click();
    commentAction.click();
    cancelButton.click();

    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(cancelButton.getAttribute("data-ui-attach-selected")).toBe("true");
  });

  it("preserves selected element dimensions and computed colors in the visual preview", () => {
    const { cancelButton, commentAction, preview } = mountFixture();
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: (element: Element) => {
        if (element === cancelButton) {
          return {
            backgroundColor: "rgb(255, 255, 255)",
            borderColor: "rgb(185, 194, 208)",
            borderRadius: "6px",
            borderStyle: "solid",
            borderWidth: "1px",
            boxSizing: "border-box",
            color: "rgb(36, 50, 70)",
            display: "inline-block",
            font: "16px sans-serif",
            fontFamily: "sans-serif",
            fontSize: "16px",
            fontWeight: "400",
            lineHeight: "normal",
            padding: "0px 14px",
          };
        }

        return originalGetComputedStyle(element);
      },
    });

    attachDemoSelection(document);
    commentAction.click();
    cancelButton.click();

    const clone = preview.querySelector<HTMLElement>("[data-ui-attach-preview-clone]");
    expect(clone?.style.width).toBe("80px");
    expect(clone?.style.height).toBe("34px");
    expect(clone?.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(clone?.style.color).toBe("rgb(36, 50, 70)");
  });

  it("runs the injected runtime smoke flow and exports JSON plus markdown", () => {
    const { button, injectedAction, output, preview } = mountFixture();

    window.history.replaceState(null, "", "/demo?token=secret#billing");
    attachDemoSelection(document);
    button.click();
    expect(output.textContent).toBe("");

    injectedAction.click();
    button.click();
    const shadow = getActivePickerShadow();
    const note = shadow?.querySelector("textarea");
    const submit = shadow?.querySelector("[data-ui-attach-submit]");
    if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      throw new Error("injected composer controls missing");
    }

    note.value = "Use the injected runtime path.";
    submit.click();

    expect(output.textContent).toContain("## Injected Runtime Export");
    expect(output.textContent).toContain("### JSON");
    expect(output.textContent).toContain("\"schemaVersion\": \"0.3.0\"");
    expect(output.textContent).toContain("### Markdown");
    expect(output.textContent).toContain("Use the injected runtime path.");
    expect(countOccurrences(output.textContent ?? "", "## User Intent")).toBe(1);
    expect(output.textContent).toContain("- Source: `web http://localhost:3000/demo`");
    expect(output.textContent).not.toContain("token=secret");
    expect(output.textContent).not.toContain("billing");
    expect(button.hasAttribute("data-ui-attach-selected")).toBe(false);
    expect(preview.textContent).toContain("Save changes");
  });

  it("keeps comment and injected runtime arm states mutually exclusive", () => {
    const { button, commentAction, injectedAction, output } = mountFixture();

    attachDemoSelection(document);
    commentAction.click();
    injectedAction.click();
    expect(commentAction.getAttribute("aria-pressed")).toBe("false");
    expect(injectedAction.getAttribute("aria-pressed")).toBe("true");

    button.click();
    expect(getComposerHosts()).toHaveLength(1);
    const shadow = getActivePickerShadow();
    const note = shadow?.querySelector("textarea");
    const submit = shadow?.querySelector("[data-ui-attach-submit]");
    if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      throw new Error("injected composer controls missing");
    }
    note.value = "Injected wins.";
    submit.click();
    expect(output.textContent).toContain("## Injected Runtime Export");

    injectedAction.click();
    commentAction.click();
    expect(injectedAction.getAttribute("aria-pressed")).toBe("false");
    expect(commentAction.getAttribute("aria-pressed")).toBe("true");
  });

  it("generates a local bookmarklet href without leaking the current query or hash", () => {
    const { bookmarkletLink } = mountFixture();

    window.history.replaceState(null, "", "/demo?token=secret#billing");
    attachDemoSelection(document);

    const source = decodeURIComponent(bookmarkletLink.href.slice("javascript:".length));
    expect(bookmarkletLink.href.startsWith("javascript:")).toBe(true);
    expect(source).toContain(
      'const moduleUrl = "http://localhost:3000/ui-attach-runtime.js"',
    );
    expect(source).toContain("await import(moduleUrl)");
    expect(source).toContain("runtime.arm()");
    expect(source).not.toContain("token=secret");
    expect(source).not.toContain("billing");
  });

  it("shows bookmarklet armed feedback and renders bookmarklet exports", () => {
    const { bookmarkletLink, output } = mountFixture();

    attachDemoSelection(document);
    window.dispatchEvent(new CustomEvent("ui-attach:armed"));

    expect(bookmarkletLink.getAttribute("aria-pressed")).toBe("true");
    expect(bookmarkletLink.textContent).toBe("Bookmarklet armed");

    window.dispatchEvent(
      new CustomEvent("ui-attach:export", {
        detail: {
          attachment: {
            schemaVersion: "0.3.0",
            id: "att_save-button",
            element: { text: "Save changes" },
          },
          intent: "Capture through bookmarklet.",
          json: "{\"id\":\"att_save-button\"}",
          markdown: "## User Intent\n\nCapture through bookmarklet.\n\n## Selected UI Element",
        },
      }),
    );

    expect(bookmarkletLink.getAttribute("aria-pressed")).toBe("false");
    expect(bookmarkletLink.textContent).toBe("MeanThis Bookmarklet");
    expect(output.textContent).toContain("## Bookmarklet Runtime Export");
    expect(output.textContent).toContain("Capture through bookmarklet.");
    expect(output.textContent).toContain("\"id\":\"att_save-button\"");
  });

  it("clears bookmarklet armed feedback on cancel", () => {
    const { bookmarkletLink } = mountFixture();

    attachDemoSelection(document);
    window.dispatchEvent(new CustomEvent("ui-attach:armed"));
    window.dispatchEvent(new CustomEvent("ui-attach:cancel"));

    expect(bookmarkletLink.getAttribute("aria-pressed")).toBe("false");
    expect(bookmarkletLink.textContent).toBe("MeanThis Bookmarklet");
  });
});

function mountFixture(): {
  bookmarkletLink: HTMLAnchorElement;
  button: HTMLElement;
  bundleAction: HTMLButtonElement;
  bundleList: HTMLElement;
  cancelButton: HTMLElement;
  commentAction: HTMLButtonElement;
  extensionGuide: HTMLElement;
  injectedAction: HTMLButtonElement;
  output: HTMLPreElement;
  outputRegion: HTMLElement;
  preview: HTMLElement;
  standaloneTools: HTMLElement;
  surface: HTMLElement;
} {
  document.body.innerHTML = `
    <main>
      <section data-ui-attach-surface>
        <h1>Profile settings</h1>
        <div id="standalone-demo-tools">
          <button id="comment-action" data-ui-attach-ignore aria-pressed="false">Comment on UI element</button>
          <button id="bundle-action" data-ui-attach-ignore aria-pressed="false">Add element to bundle</button>
          <button id="injected-action" data-ui-attach-ignore aria-pressed="false">Try injected runtime</button>
          <a id="bookmarklet-link" data-ui-attach-ignore href="#">MeanThis Bookmarklet</a>
        </div>
        <div id="extension-demo-guide" data-ui-attach-ignore hidden>
          Choose Add elements in MeanThis, then select a control on this page.
        </div>
        <button data-testid="save-button" type="button">Save changes</button>
        <button data-testid="cancel-button" type="button">Cancel</button>
      </section>
      <aside id="standalone-demo-output">
        <div id="bundle-list"></div>
        <div id="preview"></div>
        <pre id="output"></pre>
      </aside>
    </main>
  `;

  const bookmarkletLink = document.querySelector("#bookmarklet-link");
  const button = document.querySelector("[data-testid='save-button']");
  const bundleAction = document.querySelector("#bundle-action");
  const bundleList = document.querySelector("#bundle-list");
  const cancelButton = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === "Cancel",
  );
  const commentAction = document.querySelector("#comment-action");
  const extensionGuide = document.querySelector("#extension-demo-guide");
  const injectedAction = document.querySelector("#injected-action");
  const output = document.querySelector("#output");
  const outputRegion = document.querySelector("#standalone-demo-output");
  const preview = document.querySelector("#preview");
  const standaloneTools = document.querySelector("#standalone-demo-tools");
  const surface = document.querySelector("[data-ui-attach-surface]");

  if (
    !(bookmarkletLink instanceof HTMLAnchorElement) ||
    !(button instanceof HTMLElement) ||
    !(bundleAction instanceof HTMLButtonElement) ||
    !(bundleList instanceof HTMLElement) ||
    !(cancelButton instanceof HTMLElement) ||
    !(commentAction instanceof HTMLButtonElement) ||
    !(extensionGuide instanceof HTMLElement) ||
    !(injectedAction instanceof HTMLButtonElement) ||
    !(output instanceof HTMLPreElement) ||
    !(outputRegion instanceof HTMLElement) ||
    !(preview instanceof HTMLElement) ||
    !(standaloneTools instanceof HTMLElement) ||
    !(surface instanceof HTMLElement)
  ) {
    throw new Error("demo fixture missing");
  }

  button.getBoundingClientRect = () =>
    ({
      x: 4,
      y: 8,
      width: 120,
      height: 36,
      top: 8,
      left: 4,
      right: 124,
      bottom: 44,
      toJSON: () => ({}),
    }) as DOMRect;
  cancelButton.getBoundingClientRect = () =>
    ({
      x: 6,
      y: 52,
      width: 80,
      height: 34,
      top: 52,
      left: 6,
      right: 86,
      bottom: 86,
      toJSON: () => ({}),
    }) as DOMRect;

  return {
    bookmarkletLink,
    button,
    bundleAction,
    bundleList,
    cancelButton,
    commentAction,
    extensionGuide,
    injectedAction,
    output,
    outputRegion,
    preview,
    standaloneTools,
    surface,
  };
}

function getPickerShadow(): ShadowRoot | null {
  return document.querySelector<HTMLElement>("[data-ui-attach-picker-host]")?.shadowRoot ?? null;
}

function getActivePickerShadow(): ShadowRoot | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>("[data-ui-attach-picker-host]"))
      .find((host) => host.shadowRoot?.querySelector("[data-ui-attach-composer]"))
      ?.shadowRoot ?? null
  );
}

function getComposerHosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-ui-attach-picker-host]")).filter(
    (host) => host.shadowRoot?.querySelector("[data-ui-attach-composer]"),
  );
}

function submitActiveComposer(intent: string): void {
  const shadow = getActivePickerShadow();
  const note = shadow?.querySelector("textarea");
  const submit = shadow?.querySelector("[data-ui-attach-submit]");
  if (!(note instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
    throw new Error("composer controls missing");
  }
  note.value = intent;
  note.dispatchEvent(new Event("input", { bubbles: true }));
  submit.click();
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function countOccurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}
