// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPersistentOverlayController } from "./persistent-overlays";
import { createDomReplayPage, resolveDomReplayTarget } from "./replay-dom";

describe("createDomReplayPage", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test("chains element scopes without including matching roots", async () => {
    document.body.innerHTML = `
      <button>Confirm plan change</button>
      <section role="dialog" aria-label="Plan change dialog">
        <button>Confirm plan change</button>
      </section>
    `;
    setVisibleBounds(...document.querySelectorAll<HTMLElement>("button, [role=dialog]"));

    const page = createDomReplayPage(document);
    const dialog = page.getByRole?.("dialog", { name: "Plan change dialog" });
    const confirm = dialog?.getByRole?.("button", { name: "Confirm plan change" });
    const nestedDialog = dialog?.getByRole?.("dialog", { name: "Plan change dialog" });

    await expect(confirm?.count()).resolves.toBe(1);
    await expect(nestedDialog?.count()).resolves.toBe(0);
  });

  test("matches native search roles and Playwright substring names", async () => {
    document.body.innerHTML = `
      <input type="search" aria-label="Quick search">
      <input type="search" list="suggestions" aria-label="Search options">
      <datalist id="suggestions"><option value="Replay"></datalist>
      <h1>Introduction to Node.js</h1>
      <a href="/intro">Introduction</a>
      <a href="/node">Introduction to Node.js</a>
    `;
    setVisibleBounds(...document.querySelectorAll<HTMLElement>("input, h1, a"));
    const page = createDomReplayPage(document);

    await expect(page.getByRole?.("searchbox", { name: "Quick search" }).count()).resolves.toBe(1);
    await expect(page.getByRole?.("textbox", { name: "Quick search" }).count()).resolves.toBe(0);
    await expect(page.getByRole?.("combobox", { name: "Search options" }).count()).resolves.toBe(1);
    await expect(page.getByRole?.("searchbox", { name: "Search options" }).count()).resolves.toBe(0);
    await expect(page.getByRole?.("link", { name: "Introduction" }).count()).resolves.toBe(2);
    await expect(page.getByRole?.("link", { name: "INTRODUCTION" }).count()).resolves.toBe(2);
    await expect(page.getByRole?.("heading", { name: "introduction" }).count()).resolves.toBe(1);
  });

  test("skips non-role layout reads and reuses role visibility across locator attempts", async () => {
    document.body.innerHTML = `
      ${Array.from({ length: 100 }, (_, index) => `<div>Noise ${index}</div>`).join("")}
      <a href="/shared-one">Shared</a>
      <a href="/shared-two">Shared</a>
      <a href="/unique">Unique</a>
    `;
    const noiseBounds = vi.fn(() => visibleRect());
    const linkBounds = vi.fn(() => visibleRect());
    document.querySelectorAll<HTMLElement>("div").forEach((element) => {
      element.getBoundingClientRect = noiseBounds;
    });
    document.querySelectorAll<HTMLElement>("a").forEach((element) => {
      element.getBoundingClientRect = linkBounds;
    });
    const page = createDomReplayPage(document);

    await expect(page.getByRole?.("link", { name: "Shared" }).count()).resolves.toBe(2);
    await expect(page.getByRole?.("link", { name: "Unique" }).count()).resolves.toBe(1);

    expect(noiseBounds).not.toHaveBeenCalled();
    expect(linkBounds).toHaveBeenCalledTimes(3);
  });

  test("excludes matched roots from every chained query method", async () => {
    document.body.innerHTML = `
      <label id="label-root">Account<input></label>
      <span
        id="attribute-root"
        data-testid="root-test-id"
        alt="Root alt"
        title="Root title"
        placeholder="Root placeholder"
      >Root text</span>
    `;
    const page = createDomReplayPage(document);
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
      <section class="scope">
        <button class="candidate">First</button>
        <div class="scope"><button class="candidate">Second</button></div>
      </section>
    `;

    const candidates = createDomReplayPage(document)
      .locator?.(".scope")
      .locator?.(".candidate");

    await expect(candidates?.count()).resolves.toBe(2);
  });

  test("queries an accessible same-origin frame without browser actions", async () => {
    const frame = document.createElement("iframe");
    frame.title = "Compatibility iframe";
    document.body.append(frame);
    const submit = frame.contentDocument?.createElement("button");
    if (!frame.contentDocument?.body || !submit) {
      throw new Error("same-origin iframe fixture missing");
    }
    submit.dataset.testid = "iframe-submit";
    frame.contentDocument.body.append(submit);
    setVisibleBounds(frame, submit);

    const page = createDomReplayPage(document);
    const frameScope = page.frameLocator?.('iframe[title="Compatibility iframe"]');

    await expect(frameScope?.getByTestId?.("iframe-submit").count()).resolves.toBe(1);
  });

  test("keeps label and nested frame queries inside the frame realm", async () => {
    const frame = document.createElement("iframe");
    frame.title = "Outer frame";
    document.body.append(frame);
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

    const outerScope = createDomReplayPage(document).frameLocator?.('iframe[title="Outer frame"]');

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
      <iframe title="Names frame"></iframe>
    `;
    const frame = document.querySelector<HTMLIFrameElement>("iframe");
    const frameDocument = frame?.contentDocument;
    if (!frameDocument?.body) throw new Error("names frame fixture missing");
    frameDocument.body.innerHTML = `
      <span id="shared-name">Inner name</span>
      <button aria-labelledby="shared-name"></button>
      <button aria-labelledby="outer-only">Local fallback</button>
    `;
    setVisibleBounds(...frameDocument.querySelectorAll<HTMLElement>("button"));

    const frameScope = createDomReplayPage(document).frameLocator?.('iframe[title="Names frame"]');

    await expect(frameScope?.getByRole?.("button", { name: "Inner name" }).count()).resolves.toBe(1);
    await expect(
      frameScope?.getByRole?.("button", { name: "Outer duplicate" }).count(),
    ).resolves.toBe(0);
    await expect(
      frameScope?.getByRole?.("button", { name: "Outer only" }).count(),
    ).resolves.toBe(0);
  });

  test("includes iframe hosts and outer ancestors in visibility", async () => {
    const hiddenFrame = document.createElement("iframe");
    hiddenFrame.title = "Hidden frame";
    hiddenFrame.hidden = true;
    const opacityFrame = document.createElement("iframe");
    opacityFrame.title = "Opacity frame";
    opacityFrame.style.opacity = "0";
    document.body.append(hiddenFrame, opacityFrame);
    const hiddenTarget = hiddenFrame.contentDocument?.createElement("button");
    const opacityTarget = opacityFrame.contentDocument?.createElement("button");
    if (
      !hiddenFrame.contentDocument?.body ||
      !opacityFrame.contentDocument?.body ||
      !hiddenTarget ||
      !opacityTarget
    ) {
      throw new Error("visibility frame fixture missing");
    }
    hiddenTarget.textContent = "Hidden action";
    opacityTarget.textContent = "Opacity action";
    opacityTarget.dataset.testid = "opacity-action";
    hiddenFrame.contentDocument.body.append(hiddenTarget);
    opacityFrame.contentDocument.body.append(opacityTarget);
    setVisibleBounds(hiddenFrame, opacityFrame, hiddenTarget, opacityTarget);

    const page = createDomReplayPage(document);

    await expect(
      page.frameLocator?.('iframe[title="Hidden frame"]')
        .getByRole?.("button", { name: "Hidden action" })
        .count(),
    ).resolves.toBe(0);
    await expect(
      page.frameLocator?.('iframe[title="Opacity frame"]')
        .getByTestId?.("opacity-action")
        .isVisible(),
    ).resolves.toBe(false);
    await expect(
      page.frameLocator?.('iframe[title="Opacity frame"]')
        .getByRole?.("button", { name: "Opacity action" })
        .count(),
    ).resolves.toBe(0);
  });

  test("contains inaccessible frameElement visibility as not visible", async () => {
    const frame = document.createElement("iframe");
    frame.title = "Inaccessible host";
    document.body.append(frame);
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

    const targetLocator = createDomReplayPage(document)
      .frameLocator?.('iframe[title="Inaccessible host"]')
      .getByTestId?.("inaccessible-host-target");

    await expect(targetLocator?.isVisible()).resolves.toBe(false);
  });

  test("orders labelled controls by composed target order instead of label order", async () => {
    const host = document.createElement("section");
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <input id="first" style="display: none">
      <input id="second">
      <label for="second">Field</label>
      <label for="first">Field</label>
    `;
    document.body.append(host);
    setVisibleBounds(...Array.from(shadowRoot.querySelectorAll<HTMLElement>("input")));

    const fields = createDomReplayPage(document).getByLabel?.("Field");

    await expect(fields?.count()).resolves.toBe(2);
    await expect(fields?.isVisible()).resolves.toBe(false);
  });

  test("contains invalid selectors and inaccessible frames as empty scopes", async () => {
    const inaccessible = document.createElement("iframe");
    inaccessible.title = "Cross origin";
    Object.defineProperty(inaccessible, "contentDocument", {
      configurable: true,
      get: () => {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    });
    document.body.append(inaccessible);

    const page = createDomReplayPage(document);

    await expect(page.locator?.("[").count()).resolves.toBe(0);
    await expect(page.frameLocator?.("[").getByText?.("anything").count()).resolves.toBe(0);
    await expect(
      page.frameLocator?.('iframe[title="Cross origin"]').getByText?.("anything").count(),
    ).resolves.toBe(0);
  });

  test("returns the first unique visible DOM target from the safe locator fallback chain", async () => {
    document.body.innerHTML = `
      <button data-testid="save">Save now</button>
      <button class="duplicate">Duplicate one</button>
      <button class="duplicate">Duplicate two</button>
    `;
    setVisibleBounds(...document.querySelectorAll<HTMLElement>("button"));

    await expect(resolveDomReplayTarget(document, [
      {
        strategy: "playwright.role",
        value: 'page.getByRole("button", { name: "Old name" })',
        confidence: 0.95,
      },
      { strategy: "coordinates", value: "10,20", confidence: 0.9 },
      { strategy: "xpath", value: "//button", confidence: 0.8 },
      { strategy: "css", value: ".duplicate", confidence: 0.7 },
      { strategy: "css", value: '[data-testid="save"]', confidence: 0.6 },
    ])).resolves.toBe(document.querySelector('[data-testid="save"]'));
  });

  test("restores a repeated dynamic action from its unique content anchor after reconstruction", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/1952521961831320123">First post</a>
        <button data-testid="like">7014 Likes</button>
      </article>
      <article data-testid="tweet">
        <a href="/alice/status/222">Second post</a>
        <button data-testid="like">43 Likes</button>
      </article>
    `;
    setVisibleBounds(...document.querySelectorAll<HTMLElement>("button"));
    const expected = document.querySelector<HTMLElement>(
      'article:has(a[href="/alice/status/1952521961831320123"]) [data-testid="like"]',
    );

    await expect(resolveDomReplayTarget(document, [{
      strategy: "css",
      value: 'article:has(a[href="/alice/status/1952521961831320123"]) [data-testid="like"]',
      confidence: 0.64,
    }])).resolves.toBe(expected);
  });

  test("never resolves a later item against ui-attach's own overlay shadow tree", async () => {
    document.body.innerHTML = `
      <button data-testid="first">First target</button>
      <button data-testid="second">Second target</button>
    `;
    const first = document.querySelector<HTMLElement>('[data-testid="first"]');
    const second = document.querySelector<HTMLElement>('[data-testid="second"]');
    if (!first || !second) throw new Error("multi-item fixture missing");
    setVisibleBounds(first, second);
    const overlays = createPersistentOverlayController({ root: document });
    overlays.sync([{ itemId: "att_first", label: "A", target: first }], "att_first");
    const overlayLabel = document.querySelector<HTMLElement>(
      "[data-ui-attach-overlay-root]",
    )?.shadowRoot?.querySelector<HTMLElement>(".ui-attach-label");
    if (!overlayLabel) throw new Error("overlay label fixture missing");
    setVisibleBounds(overlayLabel);

    await expect(resolveDomReplayTarget(document, [
      {
        strategy: "playwright.text",
        value: 'page.getByText("A")',
        confidence: 0.9,
      },
      {
        strategy: "playwright.testId",
        value: 'page.getByTestId("second")',
        confidence: 0.8,
      },
    ])).resolves.toBe(second);
    overlays.dispose();
  });
});

function setVisibleBounds(...elements: HTMLElement[]): void {
  elements.forEach((element) => {
    element.getBoundingClientRect = () => visibleRect();
  });
}

function visibleRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    top: 0,
    left: 0,
    right: 100,
    bottom: 30,
    toJSON: () => ({}),
  } as DOMRect;
}
