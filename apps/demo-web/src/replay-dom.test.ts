// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from "vitest";
import { createDomReplayPage } from "./replay-dom";

describe("createDomReplayPage", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test("chains element scopes inside the explicit surface without including roots", async () => {
    document.body.innerHTML = `
      <button>Confirm plan change</button>
      <main data-ui-attach-surface>
        <section role="dialog" aria-label="Plan change dialog">
          <button>Confirm plan change</button>
        </section>
      </main>
    `;
    const surface = document.querySelector<HTMLElement>("[data-ui-attach-surface]");
    if (!surface) throw new Error("surface fixture missing");
    setVisibleBounds(...document.querySelectorAll<HTMLElement>("button, [role=dialog]"));

    const page = createDomReplayPage(document, surface);
    const dialog = page.getByRole?.("dialog", { name: "Plan change dialog" });
    const confirm = dialog?.getByRole?.("button", { name: "Confirm plan change" });
    const nestedDialog = dialog?.getByRole?.("dialog", { name: "Plan change dialog" });

    await expect(confirm?.count()).resolves.toBe(1);
    await expect(nestedDialog?.count()).resolves.toBe(0);
  });

  test("matches native search roles and Playwright substring names", async () => {
    document.body.innerHTML = `
      <main data-ui-attach-surface>
        <input type="search" aria-label="Quick search">
        <input type="search" list="suggestions" aria-label="Search options">
        <datalist id="suggestions"><option value="Replay"></datalist>
        <h1>Introduction to Node.js</h1>
        <a href="/intro">Introduction</a>
        <a href="/node">Introduction to Node.js</a>
      </main>
    `;
    const surface = document.querySelector<HTMLElement>("[data-ui-attach-surface]");
    if (!surface) throw new Error("surface fixture missing");
    setVisibleBounds(...surface.querySelectorAll<HTMLElement>("input, h1, a"));
    const page = createDomReplayPage(document, surface);

    await expect(page.getByRole?.("searchbox", { name: "Quick search" }).count()).resolves.toBe(1);
    await expect(page.getByRole?.("textbox", { name: "Quick search" }).count()).resolves.toBe(0);
    await expect(page.getByRole?.("combobox", { name: "Search options" }).count()).resolves.toBe(1);
    await expect(page.getByRole?.("searchbox", { name: "Search options" }).count()).resolves.toBe(0);
    await expect(page.getByRole?.("link", { name: "Introduction" }).count()).resolves.toBe(2);
    await expect(page.getByRole?.("link", { name: "INTRODUCTION" }).count()).resolves.toBe(2);
    await expect(page.getByRole?.("heading", { name: "introduction" }).count()).resolves.toBe(1);
  });

  test("excludes matched roots from every chained query method", async () => {
    document.body.innerHTML = `
      <main data-ui-attach-surface>
        <label id="label-root">Account<input></label>
        <span
          id="attribute-root"
          data-testid="root-test-id"
          alt="Root alt"
          title="Root title"
          placeholder="Root placeholder"
        >Root text</span>
      </main>
    `;
    const surface = document.querySelector<HTMLElement>("[data-ui-attach-surface]");
    if (!surface) throw new Error("surface fixture missing");
    const page = createDomReplayPage(document, surface);
    const labelRoot = page.locator?.("#label-root");
    const attributeRoot = page.locator?.("#attribute-root");

    await expect(labelRoot?.getByLabel?.("Account").count()).resolves.toBe(0);
    await expect(attributeRoot?.getByText?.("Root text").count()).resolves.toBe(0);
    await expect(attributeRoot?.getByTestId?.("root-test-id").count()).resolves.toBe(0);
    await expect(attributeRoot?.getByAltText?.("Root alt").count()).resolves.toBe(0);
    await expect(attributeRoot?.getByTitle?.("Root title").count()).resolves.toBe(0);
    await expect(
      attributeRoot?.getByPlaceholder?.("Root placeholder").count(),
    ).resolves.toBe(0);
  });

  test("deduplicates overlapping child scopes in DOM order", async () => {
    document.body.innerHTML = `
      <main data-ui-attach-surface>
        <section class="scope">
          <button class="candidate">First</button>
          <div class="scope"><button class="candidate">Second</button></div>
        </section>
      </main>
    `;
    const surface = document.querySelector<HTMLElement>("[data-ui-attach-surface]");
    if (!surface) throw new Error("surface fixture missing");

    const candidates = createDomReplayPage(document, surface)
      .locator?.(".scope")
      .locator?.(".candidate");

    await expect(candidates?.count()).resolves.toBe(2);
  });

  test("queries an accessible same-origin frame within the explicit surface", async () => {
    const surface = document.createElement("main");
    const frame = document.createElement("iframe");
    frame.title = "Compatibility iframe";
    surface.append(frame);
    document.body.append(surface);
    const submit = frame.contentDocument?.createElement("button");
    if (!frame.contentDocument?.body || !submit) {
      throw new Error("same-origin iframe fixture missing");
    }
    submit.dataset.testid = "iframe-submit";
    frame.contentDocument.body.append(submit);
    setVisibleBounds(frame, submit);

    const page = createDomReplayPage(document, surface);
    const frameScope = page.frameLocator?.('iframe[title="Compatibility iframe"]');

    await expect(frameScope?.getByTestId?.("iframe-submit").count()).resolves.toBe(1);
  });

  test("keeps label and nested frame queries inside the frame realm", async () => {
    const surface = document.createElement("main");
    const frame = document.createElement("iframe");
    frame.title = "Outer frame";
    surface.append(frame);
    document.body.append(surface);
    const frameDocument = frame.contentDocument;
    if (!frameDocument?.body) throw new Error("outer frame fixture missing");
    frameDocument.body.innerHTML = '<label for="email">Email</label><input id="email">';
    const input = frameDocument.querySelector<HTMLElement>("#email");
    const nestedFrame = frameDocument.createElement("iframe");
    nestedFrame.title = "Nested frame";
    frameDocument.body.append(nestedFrame);
    const nestedTarget = nestedFrame.contentDocument?.createElement("button");
    if (!input || !nestedFrame.contentDocument?.body || !nestedTarget) {
      throw new Error("nested frame fixture missing");
    }
    nestedTarget.dataset.testid = "nested-submit";
    nestedFrame.contentDocument.body.append(nestedTarget);

    const outerScope = createDomReplayPage(document, surface).frameLocator?.(
      'iframe[title="Outer frame"]',
    );

    await expect(outerScope?.getByLabel?.("Email").count()).resolves.toBe(1);
    await expect(
      outerScope?.frameLocator?.('iframe[title="Nested frame"]')
        .getByTestId?.("nested-submit")
        .count(),
    ).resolves.toBe(1);
  });

  test("resolves iframe accessible-name IDs only within the iframe document", async () => {
    document.body.innerHTML = `
      <span id="shared-name">Outer duplicate</span>
      <span id="outer-only">Outer only</span>
      <main data-ui-attach-surface><iframe title="Names frame"></iframe></main>
    `;
    const surface = document.querySelector<HTMLElement>("[data-ui-attach-surface]");
    const frame = surface?.querySelector<HTMLIFrameElement>("iframe");
    const frameDocument = frame?.contentDocument;
    if (!surface || !frameDocument?.body) throw new Error("names frame fixture missing");
    frameDocument.body.innerHTML = `
      <span id="shared-name">Inner name</span>
      <button aria-labelledby="shared-name"></button>
      <button aria-labelledby="outer-only">Local fallback</button>
    `;
    setVisibleBounds(...frameDocument.querySelectorAll<HTMLElement>("button"));

    const frameScope = createDomReplayPage(document, surface).frameLocator?.(
      'iframe[title="Names frame"]',
    );

    await expect(frameScope?.getByRole?.("button", { name: "Inner name" }).count()).resolves.toBe(1);
    await expect(
      frameScope?.getByRole?.("button", { name: "Outer duplicate" }).count(),
    ).resolves.toBe(0);
    await expect(
      frameScope?.getByRole?.("button", { name: "Outer only" }).count(),
    ).resolves.toBe(0);
  });

  test("treats targets inside hidden iframe hosts as not visible", async () => {
    const surface = document.createElement("main");
    const frame = document.createElement("iframe");
    frame.title = "Hidden host";
    frame.hidden = true;
    surface.append(frame);
    document.body.append(surface);
    const target = frame.contentDocument?.createElement("button");
    if (!frame.contentDocument?.body || !target) {
      throw new Error("hidden host fixture missing");
    }
    target.dataset.testid = "hidden-host-target";
    frame.contentDocument.body.append(target);
    setVisibleBounds(frame, target);

    const targetLocator = createDomReplayPage(document, surface)
      .frameLocator?.('iframe[title="Hidden host"]')
      .getByTestId?.("hidden-host-target");

    await expect(targetLocator?.isVisible()).resolves.toBe(false);
  });

  test("treats opacity-zero ancestors outside a frame as not visible", async () => {
    const surface = document.createElement("main");
    const hiddenAncestor = document.createElement("section");
    hiddenAncestor.style.opacity = "0";
    const frame = document.createElement("iframe");
    frame.title = "Opacity ancestor";
    hiddenAncestor.append(frame);
    surface.append(hiddenAncestor);
    document.body.append(surface);
    const target = frame.contentDocument?.createElement("button");
    if (!frame.contentDocument?.body || !target) {
      throw new Error("opacity ancestor fixture missing");
    }
    target.dataset.testid = "opacity-ancestor-target";
    frame.contentDocument.body.append(target);
    setVisibleBounds(frame, target);

    const targetLocator = createDomReplayPage(document, surface)
      .frameLocator?.('iframe[title="Opacity ancestor"]')
      .getByTestId?.("opacity-ancestor-target");

    await expect(targetLocator?.isVisible()).resolves.toBe(false);
  });

  test("fails closed when frameElement visibility is inaccessible", async () => {
    const surface = document.createElement("main");
    const frame = document.createElement("iframe");
    frame.title = "Inaccessible host";
    surface.append(frame);
    document.body.append(surface);
    const frameWindow = frame.contentWindow;
    const target = frame.contentDocument?.createElement("button");
    if (!frameWindow || !frame.contentDocument?.body || !target) {
      throw new Error("inaccessible host fixture missing");
    }
    target.dataset.testid = "inaccessible-host-target";
    frame.contentDocument.body.append(target);
    setVisibleBounds(frame, target);
    Object.defineProperty(frameWindow, "frameElement", {
      configurable: true,
      get: () => {
        throw new DOMException("Blocked frameElement", "SecurityError");
      },
    });

    const targetLocator = createDomReplayPage(document, surface)
      .frameLocator?.('iframe[title="Inaccessible host"]')
      .getByTestId?.("inaccessible-host-target");

    await expect(targetLocator?.isVisible()).resolves.toBe(false);
  });

  test("orders labelled controls by target DOM order instead of label order", async () => {
    document.body.innerHTML = `
      <main data-ui-attach-surface>
        <input id="first" style="display: none">
        <input id="second">
        <label for="second">Field</label>
        <label for="first">Field</label>
      </main>
    `;
    const surface = document.querySelector<HTMLElement>("[data-ui-attach-surface]");
    if (!surface) throw new Error("surface fixture missing");
    setVisibleBounds(...surface.querySelectorAll<HTMLElement>("input"));

    const fields = createDomReplayPage(document, surface).getByLabel?.("Field");

    await expect(fields?.count()).resolves.toBe(2);
    await expect(fields?.isVisible()).resolves.toBe(false);
  });

  test("contains invalid selectors and inaccessible frames as empty scopes", async () => {
    const surface = document.createElement("main");
    const inaccessible = document.createElement("iframe");
    inaccessible.title = "Cross origin";
    Object.defineProperty(inaccessible, "contentDocument", {
      configurable: true,
      get: () => {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    });
    surface.append(inaccessible);
    document.body.append(surface);

    const page = createDomReplayPage(document, surface);

    await expect(page.locator?.("[").count()).resolves.toBe(0);
    await expect(page.frameLocator?.("[").getByText?.("anything").count()).resolves.toBe(0);
    await expect(
      page.frameLocator?.('iframe[title="Cross origin"]').getByText?.("anything").count(),
    ).resolves.toBe(0);
  });
});

function setVisibleBounds(...elements: HTMLElement[]): void {
  elements.forEach((element) => {
    element.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        top: 0,
        left: 0,
        right: 100,
        bottom: 30,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}
