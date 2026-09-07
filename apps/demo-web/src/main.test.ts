// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { attachDemoSelection } from "./main";

describe("MeanThis SDK widget demo", () => {
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    document.documentElement
      .querySelectorAll("[data-meanthis-web-widget-host], [data-meanthis-surface-claim], [data-ui-attach-overlay-root]")
      .forEach((element) => element.remove());
    document.documentElement.removeAttribute("data-meanthis-widget-workbench");
    document.body.replaceChildren();
    document.body.removeAttribute("data-ui-attach-demo-mode");
    document.body.removeAttribute("data-ui-attach-widget-inspectable");
    window.history.replaceState({}, "", "/");
  });

  test("uses the shared SDK widget as the only default demo surface", () => {
    mountFixture("/");

    expect(document.body.dataset.uiAttachDemoMode).toBe("sdk-widget");
    expect(document.querySelector<HTMLElement>("#sdk-widget-demo-stage")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#sdk-widget-demo-guide")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#extension-demo-guide")?.hidden).toBe(true);
    expect(document.querySelector("[data-meanthis-web-widget-host]")).not.toBeNull();
  });

  test("keeps the extension target free of an SDK owner", () => {
    mountFixture("/?ui-attach-demo=extension-target");

    expect(document.body.dataset.uiAttachDemoMode).toBe("extension-target");
    expect(document.querySelector<HTMLElement>("#sdk-widget-demo-stage")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#extension-demo-guide")?.hidden).toBe(false);
    expect(document.querySelector("[data-meanthis-web-widget-host]")).toBeNull();
    expect(document.querySelector("[data-meanthis-surface-claim]")).toBeNull();
  });

  test("exposes the exact shared widget for IAB inspection without a second controller", () => {
    mountFixture("/?ui-attach-inspect=1");
    const host = document.querySelector<HTMLElement>("[data-meanthis-web-widget-host]");
    const start = host?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='toggle-selection']",
    );
    const first = requireButton("#save");
    const second = requireButton("#cancel");

    expect(document.body.dataset.uiAttachWidgetInspectable).toBe("true");
    expect(document.documentElement.dataset.meanthisWidgetWorkbench).toBe("true");
    expect(host?.dataset.meanthisInspectableDom).toBe("true");
    expect(start).not.toBeNull();

    start?.click();
    first.click();
    second.click();

    const overlayRoot = document.querySelector<HTMLElement>("[data-ui-attach-overlay-root]");
    expect(overlayRoot).not.toBeNull();
    expect(overlayRoot?.shadowRoot?.querySelectorAll(".ui-attach-label")).toHaveLength(2);
  });

  test("disposes the SDK owner on pagehide", () => {
    mountFixture("/");
    expect(document.querySelector("[data-meanthis-web-widget-host]")).not.toBeNull();

    window.dispatchEvent(new Event("pagehide"));

    expect(document.querySelector("[data-meanthis-web-widget-host]")).toBeNull();
    expect(document.querySelector("[data-meanthis-surface-claim]")).toBeNull();
  });
});

function mountFixture(url: string): void {
  window.history.replaceState({}, "", url);
  document.body.innerHTML = `
    <div id="extension-demo-guide" hidden></div>
    <div id="sdk-widget-demo-guide" hidden></div>
    <main data-ui-attach-surface>
      <section id="sdk-widget-demo-stage" hidden>
        <button id="save" data-testid="save-button">Save changes</button>
        <button id="cancel" data-testid="cancel-button">Cancel</button>
      </section>
    </main>
  `;
  attachDemoSelection(document);
}

function requireButton(selector: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing ${selector}`);
  return button;
}
