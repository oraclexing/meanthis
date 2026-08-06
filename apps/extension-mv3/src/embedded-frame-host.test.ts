// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { inspectEmbeddedFrameHost } from "./embedded-frame-host";

describe("embedded frame host inspection", () => {
  test("replays one visible iframe host and reports its base-aware source without query data", async () => {
    document.head.innerHTML = '<base href="https://frames.example.test/embed/v2/">';
    document.body.innerHTML = `
      <iframe title="Documentation" src="./start?token=secret#private"></iframe>
    `;
    const frame = document.querySelector("iframe");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("frame fixture missing");
    frame.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });

    await expect(inspectEmbeddedFrameHost(document, [{
      strategy: "playwright.title",
      value: 'page.getByTitle("Documentation")',
      confidence: 0.9,
    }])).resolves.toEqual({
      frameHostCount: 1,
      frameOrigin: "https://frames.example.test",
      framePathname: "/embed/v2/start",
    });
  });

  test("fails closed when the replayed target is not the only frame host", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `
      <iframe title="Documentation" src="https://frames.example.test/start"></iframe>
      <iframe title="Other" src="https://other.example.test/"></iframe>
    `;
    document.querySelectorAll("iframe").forEach((frame) => {
      frame.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        top: 0,
        right: 100,
        bottom: 100,
        left: 0,
        toJSON: () => ({}),
      });
    });

    await expect(inspectEmbeddedFrameHost(document, [{
      strategy: "playwright.title",
      value: 'page.getByTitle("Documentation")',
      confidence: 0.9,
    }])).resolves.toEqual({
      frameHostCount: 2,
      frameOrigin: "https://frames.example.test",
      framePathname: "/start",
    });
  });
});
