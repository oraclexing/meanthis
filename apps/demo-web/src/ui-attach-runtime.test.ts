// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUiAttachInjectedRuntime } from "./ui-attach-runtime";

describe("demo injected runtime module", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("exports the injected runtime factory for bookmarklet imports", () => {
    expect(typeof createUiAttachInjectedRuntime).toBe("function");
  });

  it("ignores demo launcher controls while armed", () => {
    document.body.innerHTML = `
      <main>
        <section data-ui-attach-surface>
          <a id="bookmarklet-link" data-ui-attach-ignore href="#">MeanThis Bookmarklet</a>
          <button data-testid="save-button" type="button">Save changes</button>
        </section>
      </main>
    `;
    const link = document.querySelector("#bookmarklet-link");
    const button = document.querySelector("[data-testid='save-button']");
    if (!(link instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      throw new Error("fixture missing");
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

    const runtime = createUiAttachInjectedRuntime({
      root: document,
      onExport: vi.fn(),
    });

    runtime.arm();
    link.click();
    expect(getComposer()).toBeNull();

    button.click();
    expect(getComposer()).not.toBeNull();

    runtime.destroy();
  });
});

function getComposer(): Element | null {
  return document
    .querySelector<HTMLElement>("[data-ui-attach-picker-host]")
    ?.shadowRoot?.querySelector("[data-ui-attach-composer]") ?? null;
}
