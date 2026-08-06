// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { createContextTargetTracker } from "./context-target";

describe("createContextTargetTracker", () => {
  test("records the latest right-clicked element", () => {
    document.body.innerHTML = '<main><button id="save">Save changes</button></main>';
    const tracker = createContextTargetTracker(document);
    const button = document.querySelector("#save");

    button?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(tracker.getLatestTarget()).toBe(button);
    tracker.dispose();
  });

  test("normalizes nested text to its closest native interactive ancestor", () => {
    document.body.innerHTML = `
      <button id="search"><span id="search-label">Search</span></button>
      <p><span id="ordinary-label">Ordinary text</span></p>
    `;
    const button = document.querySelector("#search");
    const nestedLabel = document.querySelector("#search-label");
    const ordinaryLabel = document.querySelector("#ordinary-label");
    const tracker = createContextTargetTracker(document);

    nestedLabel?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(tracker.getLatestTarget()).toBe(button);

    ordinaryLabel?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(tracker.getLatestTarget()).toBe(ordinaryLabel);
    tracker.dispose();
  });

  test("finds an activation ancestor across an open shadow boundary", () => {
    document.body.innerHTML = '<button id="search"><ui-search-label></ui-search-label></button>';
    const button = document.querySelector("#search");
    const host = document.querySelector("ui-search-label");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow label host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const nestedLabel = document.createElement("span");
    nestedLabel.textContent = "Search";
    shadowRoot.append(nestedLabel);
    const tracker = createContextTargetTracker(document);

    nestedLabel.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, composed: true }),
    );

    expect(tracker.getLatestTarget()).toBe(button);
    tracker.dispose();
  });

  test("prefers the closest activation ancestor without promoting through it", () => {
    document.body.innerHTML = '<h1><a href="/intro"><span>Introduction</span></a></h1>';
    const link = document.querySelector("a");
    const nestedLabel = document.querySelector("span");
    const tracker = createContextTargetTracker(document);

    nestedLabel?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(tracker.getLatestTarget()).toBe(link);
    tracker.dispose();
  });

  test("records the composed shadow target instead of the retargeted host", () => {
    document.body.innerHTML = '<div id="shadow-host"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.dataset.testid = "shadow-confirm";
    button.textContent = "Confirm";
    shadowRoot.append(button);
    const tracker = createContextTargetTracker(document);

    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true }));

    expect(tracker.getLatestTarget()).toBe(button);
    tracker.dispose();
  });

  test("ignores composed shadow targets inside an ignored host", () => {
    document.body.innerHTML = '<div id="shadow-host" data-ui-attach-ignore="true"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Internal";
    shadowRoot.append(button);
    const tracker = createContextTargetTracker(document);

    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true }));

    expect(tracker.getLatestTarget()).toBeNull();
    tracker.dispose();
  });

  test("tracks elements in a detached HTML document", () => {
    const detachedDocument = document.implementation.createHTMLDocument("Detached");
    const button = detachedDocument.createElement("button");
    detachedDocument.body.append(button);
    const tracker = createContextTargetTracker(detachedDocument);

    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(tracker.getLatestTarget()).toBe(button);
    tracker.dispose();
  });

  test("ignores page root elements and explicit ui-attach UI", () => {
    document.body.innerHTML = '<button data-ui-attach-ignore="true">Internal</button>';
    const tracker = createContextTargetTracker(document);
    const ignored = document.querySelector("button");

    document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    ignored?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(tracker.getLatestTarget()).toBeNull();
    tracker.dispose();
  });

  test("one-shot consumes the target for a preview seed", () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    const tracker = createContextTargetTracker(document);
    const button = document.querySelector("#save");

    button?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(tracker.takeLatestTarget()).toBe(button);
    expect(tracker.getLatestTarget()).toBeNull();
    tracker.dispose();
  });
});
