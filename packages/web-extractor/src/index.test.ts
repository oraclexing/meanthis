// @vitest-environment jsdom

import { UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS } from "@meanthis/schema";
import { describe, expect, it, vi } from "vitest";
import {
  deriveAttachmentDisclosure,
  extractElementAttachment,
  redactRecognizedSensitiveText,
} from "./index";

describe("redactRecognizedSensitiveText", () => {
  it("scrubs URL userinfo embedded in shared text", () => {
    const value = "Open http://alice:hunter@localhost/path to inspect the fixture.";

    expect(redactRecognizedSensitiveText(value)).toBe(
      "Open http://localhost/path to inspect the fixture.",
    );
  });

  it.each([
    ["Open https://alice@localhost/path", "Open https://localhost/path"],
    ["Open //alice:hunter@localhost/path", "Open //localhost/path"],
    [
      "Open https%3A%2F%2Falice%3Ahunter%40localhost%2Fpath",
      "Open https%3A%2F%2Flocalhost%2Fpath",
    ],
    [
      "First http://alice:hunter@one.test/path then https://bob:secret@two.test/path",
      "First http://one.test/path then https://two.test/path",
    ],
  ])("scrubs URL userinfo variant %#", (value, expected) => {
    const redacted = redactRecognizedSensitiveText(value);

    expect(redacted).toBe(expected);
    expect(redactRecognizedSensitiveText(redacted)).toBe(redacted);
  });

  it("fails closed after the bounded number of encoded URL starts", () => {
    const encodedUrl = "https%3A%2F%2Fhost.test%2Fpath";
    const legalValue = Array.from({ length: 64 }, (_, index) =>
      `${encodedUrl}${index}`
    ).join("|");
    const abusiveValue = `${legalValue}|${encodedUrl}64`;

    expect(redactRecognizedSensitiveText(legalValue)).toBe(legalValue);
    expect(redactRecognizedSensitiveText(abusiveValue)).toBe("[redacted:url]");
  });
});

describe("extractElementAttachment", () => {
  it("extracts deterministic facts from a selected button", () => {
    document.body.innerHTML = `
      <main>
        <form aria-label="Profile settings">
          <button type="submit" data-testid="save-button" style="display: inline-flex; color: rgb(255, 255, 255); background-color: rgb(31, 99, 255);">Save</button>
          <button type="button">Cancel</button>
        </form>
      </main>
    `;
    const button = document.querySelector("[data-testid='save-button']");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        width: 80,
        height: 32,
        top: 20,
        left: 10,
        right: 90,
        bottom: 52,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      idSeed: "save",
      locationHref: "https://example.test/settings",
      documentTitle: "Settings",
    });

    expect(attachment.id).toBe("att_save");
    expect(attachment.element.tagName).toBe("button");
    expect(attachment.element.role).toBe("button");
    expect(attachment.element.text).toBe("Save");
    expect(attachment.element.accessibleName).toBe("Save");
    expect(attachment.element.bbox).toEqual({ x: 10, y: 20, width: 80, height: 32 });
    expect(attachment.context.selectorHints).toContain("[data-testid=\"save-button\"]");
    expect(attachment.context.nearbyText).toContain("Cancel");
    expect(attachment.locatorBundle.primary).toEqual({
      strategy: "playwright.role",
      value: "page.getByRole(\"button\", { name: \"Save\" })",
      confidence: 0.92,
    });
    expect(attachment.locatorBundle.candidates).toContainEqual({
      strategy: "playwright.testId",
      value: "page.getByTestId(\"save-button\")",
      confidence: 0.86,
    });
    expect(attachment.locatorBundle.stability.replayVerified).toBe(false);
    expect(attachment.policy).toMatchObject({
      disclosureMode: "agent_safe",
      redactionLevel: "strict",
      actionMode: "suggest_patch",
      allowScreenshot: false,
      allowDomSnippet: false,
      allowNetworkSend: false,
    });
  });

  it("caps selected DOM text before building disclosure, locators, and the attachment id", () => {
    const button = document.createElement("button");
    button.textContent = "x".repeat(100_000);

    const attachment = extractElementAttachment(button);

    expect(attachment.element.text).toBe(`${"x".repeat(15_989)}[truncated]`);
    expect(attachment.element.accessibleName).toBe("x".repeat(16_000));
    expect(attachment.id).toBe(`att_${"x".repeat(117)}_truncated_`);
    expect(JSON.stringify(attachment).length).toBeLessThanOrEqual(131_072);
  });

  it("does not materialize the selected element's complete textContent", () => {
    const button = document.createElement("button");
    button.append(document.createTextNode("x".repeat(100_000)));
    Object.defineProperty(button, "textContent", {
      configurable: true,
      get: () => {
        throw new Error("complete textContent was materialized");
      },
    });

    const attachment = extractElementAttachment(button);

    expect(attachment.element.text).toBe(`${"x".repeat(15_989)}[truncated]`);
  });

  it("preserves selected DOM text at the capture budget", () => {
    const button = document.createElement("button");
    button.textContent = "y".repeat(16_000);

    const attachment = extractElementAttachment(button);

    expect(attachment.element.text).toBe("y".repeat(16_000));
    expect(attachment.element.accessibleName).toBe("y".repeat(16_000));
  });

  it("does not mark selected DOM text truncated when the node budget is exactly exhausted", () => {
    const button = document.createElement("button");
    for (let index = 0; index < 9_999; index += 1) {
      button.append(document.createElement("span"));
    }
    button.append(document.createTextNode("x"));

    expect(extractElementAttachment(button).element.text).toBe("x");
  });

  it("keeps stable data-testid and id seeds ahead of the bounded text seed", () => {
    const button = document.createElement("button");
    button.dataset.testid = "stable-target";
    button.id = "stable-id";
    button.textContent = "x".repeat(100_000);

    expect(extractElementAttachment(button).id).toBe("att_stable-target");

    button.removeAttribute("data-testid");
    expect(extractElementAttachment(button).id).toBe("att_stable-id");
  });

  it("skips overlong selector attributes instead of emitting nonexistent locators", () => {
    const button = document.createElement("button");
    const overlongValue = "q".repeat(16_001);
    button.textContent = "Save";
    button.setAttribute("data-testid", overlongValue);
    button.id = overlongValue;
    button.setAttribute("type", overlongValue);
    button.setAttribute("placeholder", overlongValue);
    button.setAttribute("alt", overlongValue);
    button.setAttribute("title", overlongValue);

    const attachment = extractElementAttachment(button);

    expect(attachment.context.selectorHints).not.toContain(
      `[data-testid="${overlongValue}"]`,
    );
    expect(attachment.context.selectorHints).not.toContain(`#${overlongValue}`);
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.testId" }),
    );
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.placeholder" }),
    );
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.altText" }),
    );
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.title" }),
    );
    expect(attachment.locatorBundle.candidates).toContainEqual(
      expect.objectContaining({ strategy: "coordinates" }),
    );
  });

  it("never emits a locator that exceeds the replay consumer contract", () => {
    const button = document.createElement("button");
    button.dataset.testid = "q".repeat(5_000);
    button.textContent = "x".repeat(100_000);

    const attachment = extractElementAttachment(button);

    expect(attachment.locatorBundle.candidates).toContainEqual(
      expect.objectContaining({ strategy: "coordinates" }),
    );
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.testId" }),
    );
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.role" }),
    );
    expect(
      attachment.locatorBundle.candidates.every(
        (candidate) =>
          candidate.strategy === "coordinates" ||
          candidate.value.length <= UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS,
      ),
    ).toBe(true);
  });

  it("keeps individually bounded page fields within the final attachment budget", () => {
    const button = document.createElement("button");
    const longValue = "z".repeat(16_000);
    button.textContent = longValue;
    for (const name of [
      "aria-label",
      "data-testid",
      "id",
      "placeholder",
      "alt",
      "title",
      "role",
      "type",
    ]) {
      button.setAttribute(name, longValue);
    }

    const attachment = extractElementAttachment(button);

    expect(JSON.stringify(attachment).length).toBeLessThanOrEqual(131_072);
  });

  it("fails closed when a derived attachment exceeds the final attachment budget", () => {
    const button = document.createElement("button");
    button.textContent = "Save";
    const attachment = extractElementAttachment(button, { disclosureMode: "full_debug" });
    attachment.context.nearbyText = Array.from(
      { length: 10 },
      () => "z".repeat(16_000),
    );

    expect(() => deriveAttachmentDisclosure(attachment, "full_debug")).toThrow(
      "MeanThis attachment exceeded 131072 serialized characters.",
    );
  });

  it("captures only a complete valid opaque source anchor", () => {
    document.body.innerHTML = `
      <button
        data-ui-attach-build-id="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        data-ui-attach-source-id="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        data-ui-attach-source-file="src/Settings.tsx"
      >Save</button>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const attachment = extractElementAttachment(button);

    expect(attachment.sourceAnchor).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sourceId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(JSON.stringify(attachment.sourceAnchor)).not.toContain("Settings.tsx");
  });

  it.each([
    ["missing source id", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", null],
    ["missing build id", null, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    ["malformed source id", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short"],
  ])("omits a %s source anchor", (_name, buildId, sourceId) => {
    const button = document.createElement("button");
    if (buildId !== null) button.setAttribute("data-ui-attach-build-id", buildId);
    if (sourceId !== null) button.setAttribute("data-ui-attach-source-id", sourceId);

    expect(extractElementAttachment(button).sourceAnchor).toBeUndefined();
  });

  it("excludes aria-hidden descendants from the fallback accessible name", () => {
    document.body.innerHTML =
      '<button><span aria-hidden="true">Beta</span><span>Save</span></button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("Save");
    expect(attachment.locatorBundle.primary?.value).toContain('name: "Save"');
  });

  it("prefers a concise role name when fallback descendant text contains long dynamic detail", () => {
    document.body.innerHTML =
      '<button><span>Gemini 3.1 Pro Preview</span><span>gemini-3.1-pro-preview</span><span>Our latest SOTA reasoning model with unprecedented depth and nuance, and powerful multimodal understanding and coding capabilities</span></button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("model button fixture missing");
    }

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe(
      "Gemini 3.1 Pro Previewgemini-3.1-pro-previewOur latest SOTA reasoning model with unprecedented depth and nuance, and powerful multimodal understanding and coding capabilities",
    );
    expect(attachment.locatorBundle.primary).toEqual({
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Gemini 3.1 Pro Preview" })',
      confidence: 0.92,
      notes: "concise accessible name",
    });
    expect(attachment.locatorBundle.candidates).toContainEqual({
      strategy: "playwright.role",
      value:
        'page.getByRole("button", { name: "Gemini 3.1 Pro Previewgemini-3.1-pro-previewOur latest SOTA reasoning model with unprecedented depth and nuance, and powerful multimodal understanding and coding capabilities" })',
      confidence: 0.92,
    });
  });

  it("excludes hidden and script siblings from nearby text", () => {
    document.body.innerHTML =
      '<section><script type="application/json">internal-script</script><div hidden>internal-hidden</div><button>Save</button></section>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const attachment = extractElementAttachment(button);

    expect(attachment.context.nearbyText.join(" ")).not.toContain("internal-");
  });

  it("stops fallback text collection at the explicit depth budget", () => {
    const button = document.createElement("div");
    button.setAttribute("role", "button");
    let parent: HTMLElement = button;
    for (let depth = 0; depth < 512; depth += 1) {
      const child = document.createElement("span");
      parent.append(child);
      parent = child;
    }
    parent.textContent = "unreachable-deep-label";
    Object.defineProperty(button, "textContent", { get: () => "" });

    const computed = getComputedStyle(button);
    const getComputedStyleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue(computed);
    try {
      const attachment = extractElementAttachment(button);
      expect(attachment.element.accessibleName).toBeNull();
    } finally {
      getComputedStyleSpy.mockRestore();
    }
  });

  it("deterministically truncates wide fallback text at the traversal node budget", () => {
    const button = document.createElement("button");
    for (let index = 0; index < 20_000; index += 1) {
      button.append(document.createTextNode(String(index % 10)));
    }
    document.body.append(button);

    const first = extractElementAttachment(button).element.accessibleName;
    const second = extractElementAttachment(button).element.accessibleName;

    expect(first).toBe(second);
    expect(first?.length).toBeGreaterThan(0);
    expect(first?.length).toBeLessThan(20_000);
    expect("0123456789".repeat(2_000).startsWith(first ?? "")).toBe(true);
  });

  it("bounds child enumeration before adding nodes to the traversal frontier", () => {
    const button = document.createElement("button");
    const textNode = document.createTextNode("x");
    let indexedReads = 0;
    const syntheticChildren = new Proxy(
      { length: 1_000_000 } as ArrayLike<Node>,
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
            if (indexedReads > 10_000) {
              throw new Error("accessible text traversal exceeded its node budget");
            }
            return textNode;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    Object.defineProperty(button, "childNodes", {
      configurable: true,
      get: () => syntheticChildren,
    });

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("x".repeat(9_999));
    expect(indexedReads).toBe(9_999);
  });

  it("uses the node budget as a depth-first composed DOM prefix", () => {
    const button = document.createElement("button");
    const wrapper = document.createElement("span");
    wrapper.textContent = "x";
    let indexedReads = 0;
    const syntheticChildren = new Proxy(
      { length: 9_999 } as ArrayLike<Node>,
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
            return wrapper;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    Object.defineProperty(button, "childNodes", {
      configurable: true,
      get: () => syntheticChildren,
    });

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("x".repeat(4_999));
    expect(indexedReads).toBe(5_000);
  });

  it("caps fallback accessible text by the shared character budget", () => {
    const button = document.createElement("button");
    button.textContent = "x".repeat(20_000);

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("x".repeat(16_000));
  });

  it("shares one traversal budget across all nearby siblings", () => {
    const parent = document.createElement("section");
    const target = document.createElement("button");
    target.setAttribute("aria-label", "Target");
    const emptySibling = document.createElement("span");
    parent.append(target, emptySibling);

    let indexedReads = 0;
    const syntheticChildren = new Proxy(
      { length: 1_000_000 } as ArrayLike<Element>,
      {
        get(targetCollection, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
            if (indexedReads > 10_000) {
              throw new Error("nearby text traversal exceeded its shared node budget");
            }
            return property === "0" ? target : emptySibling;
          }
          return Reflect.get(targetCollection, property, receiver);
        },
      },
    );
    Object.defineProperty(parent, "children", {
      configurable: true,
      get: () => syntheticChildren,
    });

    const attachment = extractElementAttachment(target);

    expect(attachment.context.nearbyText).toEqual([]);
    expect(indexedReads).toBe(10_000);
  });

  it("skips hidden subtrees without spending the traversal budget on descendants", () => {
    const button = document.createElement("button");
    const hidden = document.createElement("span");
    hidden.hidden = true;
    for (let index = 0; index < 12_000; index += 1) {
      hidden.append(document.createTextNode("hidden"));
    }
    const visible = document.createElement("span");
    visible.textContent = "Visible label";
    button.append(hidden, visible);
    document.body.append(button);

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("Visible label");
    expect(attachment.element.accessibleName).not.toContain("hidden");
  });

  it("collects slotted fallback text in deterministic composed DOM order", () => {
    const button = document.createElement("div");
    button.setAttribute("role", "button");
    button.textContent = "Slotted";
    const shadowRoot = button.attachShadow({ mode: "open" });
    const before = document.createTextNode("Before ");
    const slot = document.createElement("slot");
    const hidden = document.createElement("span");
    hidden.setAttribute("aria-hidden", "true");
    hidden.textContent = "Hidden";
    const after = document.createTextNode(" After");
    shadowRoot.append(before, slot, hidden, after);

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("Before Slotted After");
  });

  it("collects directly assigned slot text without eagerly materializing assigned nodes", () => {
    const button = document.createElement("div");
    button.setAttribute("role", "button");
    button.textContent = "Slotted";
    const shadowRoot = button.attachShadow({ mode: "open" });
    const slot = document.createElement("slot");
    shadowRoot.append(slot);
    const assignedNodesSpy = vi
      .spyOn(slot, "assignedNodes")
      .mockImplementation(() => {
        throw new Error("assignedNodes must not be eagerly materialized");
      });

    try {
      const attachment = extractElementAttachment(button);
      expect(attachment.element.accessibleName).toBe("Slotted");
    } finally {
      assignedNodesSpy.mockRestore();
    }
  });

  it("does not charge one slot for light DOM nodes assigned to another slot", () => {
    const button = document.createElement("div");
    button.setAttribute("role", "button");
    const shadowRoot = button.attachShadow({ mode: "open" });
    const slotA = document.createElement("slot");
    slotA.name = "a";
    const slotB = document.createElement("slot");
    slotB.name = "b";
    shadowRoot.append(slotA, slotB);

    const assignedToB = document.createElement("span");
    Object.defineProperty(assignedToB, "assignedSlot", { get: () => slotB });
    const assignedToA = document.createTextNode("A");
    Object.defineProperty(assignedToA, "assignedSlot", { get: () => slotA });
    let indexedReads = 0;
    const syntheticLightChildren = new Proxy(
      { length: 9_999 } as ArrayLike<Node>,
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
            return Number(property) === 9_998 ? assignedToA : assignedToB;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    Object.defineProperty(button, "childNodes", {
      configurable: true,
      get: () => syntheticLightChildren,
    });

    const attachment = extractElementAttachment(button);

    expect(attachment.element.accessibleName).toBe("A");
    expect(indexedReads).toBe(9_999);
  });

  it("generates placeholder alt-text and title locator candidates", () => {
    document.body.innerHTML = `
      <input placeholder="Search projects">
      <img alt="Team logo">
      <div title="Project settings"></div>
    `;
    const input = document.querySelector("input");
    const image = document.querySelector("img");
    const titleElement = document.querySelector("div");
    if (
      !(input instanceof HTMLInputElement) ||
      !(image instanceof HTMLImageElement) ||
      !(titleElement instanceof HTMLDivElement)
    ) {
      throw new Error("locator signal fixtures missing");
    }

    expect(extractElementAttachment(input).locatorBundle.candidates).toContainEqual(
      expect.objectContaining({
        strategy: "playwright.placeholder",
        value: 'page.getByPlaceholder("Search projects")',
      }),
    );
    expect(extractElementAttachment(image).locatorBundle.candidates).toContainEqual(
      expect.objectContaining({
        strategy: "playwright.altText",
        value: 'page.getByAltText("Team logo")',
      }),
    );
    expect(extractElementAttachment(titleElement).locatorBundle.candidates).toContainEqual(
      expect.objectContaining({
        strategy: "playwright.title",
        value: 'page.getByTitle("Project settings")',
      }),
    );
  });

  it("escapes a leading-digit id when CSS.escape is unavailable", () => {
    const originalCss = globalThis.CSS;
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: {},
    });

    try {
      document.body.innerHTML = '<button id="123">Save</button>';
      const button = document.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("button fixture missing");
      }

      const attachment = extractElementAttachment(button);

      expect(attachment.context.selectorHints).toContain("#\\31 23");
    } finally {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        value: originalCss,
      });
    }
  });

  it("redacts values already declared sensitive during downgrade", () => {
    const businessIdentifier = "client-record-4937";
    document.body.innerHTML = `<button>${businessIdentifier}</button>`;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, {
      idSeed: "declared-sensitive-fixture",
      disclosureMode: "full_debug",
    });
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["element.text", "element.accessibleName"],
    };

    const result = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.element.text).toBe("[redacted:declared-sensitive]");
    expect(result.attachment.element.accessibleName).toBe(
      "[redacted:declared-sensitive]",
    );
    expect(JSON.stringify(result.attachment)).not.toContain(businessIdentifier);
    expect(result.attachment.policy.redactedFields).toEqual(
      expect.arrayContaining([
        "element.text",
        "element.accessibleName",
        "locatorBundle.candidates",
      ]),
    );
    expect(result.attachment.policy.includedSensitiveFields).not.toEqual(
      expect.arrayContaining(["element.text", "element.accessibleName"]),
    );
  });

  it("replaces a declared scalar that has a recognized fragment and raw remainder", () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, { disclosureMode: "full_debug" });
    fullDebug.element.text = "[redacted:secret] trailing-private-value";
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["element.text"],
    };

    const result = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.element.text).toBe("[redacted:declared-sensitive]");
    expect(JSON.stringify(result.attachment)).not.toContain("trailing-private-value");
  });

  it("clears a mixed declared-sensitive array", () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, { disclosureMode: "full_debug" });
    fullDebug.context.nearbyText = ["[redacted:email] raw-remainder", "other-private-value"];
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["context.nearbyText"],
    };

    const result = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.context.nearbyText).toEqual([]);
  });

  it("clears a separately declared-sensitive source URL", () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, {
      locationHref: "https://example.test/private-path",
      disclosureMode: "full_debug",
    });
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["source.url"],
    };

    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(agentSafe).toMatchObject({ ok: true });
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
      expect(JSON.stringify(agentSafe.attachment)).not.toContain("private-path");
      expect(agentSafe.attachment.policy.redactedFields).toContain("source.url");
      expect(agentSafe.attachment.policy.includedSensitiveFields).not.toContain("source.url");
    }
    expect(diagnostic).toMatchObject({ ok: true });
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
  });

  it("preserves structural developer-diagnostic source URL redaction on re-derivation", () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, {
      locationHref: "https://example.test/private-path",
      disclosureMode: "full_debug",
    });
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["source.url"],
    };

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    expect(diagnostic.attachment.policy.redactedFields).toContain("source.url");
    expect(diagnostic.attachment.policy.includedSensitiveFields).not.toContain("source.url");
    expect(deriveAttachmentDisclosure(diagnostic.attachment, "developer_diagnostic")).toEqual({
      ok: true,
      attachment: diagnostic.attachment,
    });
  });

  it("clears locators instead of replacing short declared values inside their syntax", () => {
    document.body.innerHTML = '<button>a</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, { disclosureMode: "full_debug" });
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["element.text", "element.accessibleName"],
    };

    const result = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.locatorBundle.primary).toBeNull();
    expect(result.attachment.locatorBundle.candidates).toEqual([]);
    expect(JSON.stringify(result.attachment)).not.toContain("p[redacted:declared-sensitive]ge");
  });

  it("does not mark locators redacted for a source URL-only declaration", () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, {
      locationHref: "https://example.test/private-path",
      disclosureMode: "full_debug",
    });
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["source.url"],
    };

    const result = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.locatorBundle.primary).toEqual(fullDebug.locatorBundle.primary);
    expect(result.attachment.policy.redactedFields).not.toContain("locatorBundle.candidates");
  });

  it("keeps repeated agent-safe derivation stable", () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const fullDebug = extractElementAttachment(button, {
      locationHref: "https://example.test/private-path",
      disclosureMode: "full_debug",
    });
    fullDebug.policy = {
      ...fullDebug.policy,
      includedSensitiveFields: ["source.url"],
    };

    const first = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = deriveAttachmentDisclosure(first.attachment, "agent_safe");

    expect(second).toEqual({ ok: true, attachment: first.attachment });
  });

  it("preserves a normal agent-safe attachment when deriving agent-safe again", () => {
    document.body.innerHTML = '<button>Invite ada@example.com</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("button fixture missing");
    }

    const agentSafe = extractElementAttachment(button, {
      locationHref: "https://example.test/team?token=secret#members",
      disclosureMode: "agent_safe",
    });

    expect(deriveAttachmentDisclosure(agentSafe, "agent_safe")).toEqual({
      ok: true,
      attachment: agentSafe,
    });
  });

  it("uses an associated form label as the accessible name", () => {
    document.body.innerHTML = `
      <label for="email">Email address</label>
      <input id="email" type="email">
    `;
    const input = document.querySelector("#email");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("input fixture missing");
    }

    const attachment = extractElementAttachment(input, {
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      idSeed: "native-label",
      locationHref: "https://example.test/form",
      documentTitle: "Form",
    });

    expect(attachment.element.accessibleName).toBe("Email address");
  });

  it("uses the native heading role for HTML heading elements", () => {
    document.body.innerHTML = "<h1>Example Domain</h1>";
    const heading = document.querySelector("h1");
    if (!(heading instanceof HTMLHeadingElement)) {
      throw new Error("heading fixture missing");
    }

    const attachment = extractElementAttachment(heading, {
      idSeed: "example-heading",
      locationHref: "https://example.test/",
    });

    expect(attachment.element.role).toBe("heading");
    expect(attachment.locatorBundle.primary).toEqual({
      strategy: "playwright.role",
      value: 'page.getByRole("heading", { name: "Example Domain" })',
      confidence: 0.92,
    });
  });

  it("uses the native searchbox role for search inputs", () => {
    document.body.innerHTML = '<input type="search" aria-label="Quick search">';
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("search input fixture missing");
    }

    const attachment = extractElementAttachment(input, {
      idSeed: "quick-search",
      locationHref: "https://example.test/docs",
    });

    expect(attachment.element.role).toBe("searchbox");
    expect(attachment.locatorBundle.primary).toEqual({
      strategy: "playwright.role",
      value: 'page.getByRole("searchbox", { name: "Quick search" })',
      confidence: 0.92,
    });
  });

  it("uses the native combobox role for search inputs backed by a datalist", () => {
    document.body.innerHTML = `
      <input type="search" list="choices" aria-label="Quick search">
      <datalist id="choices"><option value="Replay"></datalist>
    `;
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("search datalist fixture missing");
    }

    const attachment = extractElementAttachment(input, {
      idSeed: "quick-search-options",
      locationHref: "https://example.test/docs",
    });

    expect(attachment.element.role).toBe("combobox");
    expect(attachment.locatorBundle.primary?.value).toBe(
      'page.getByRole("combobox", { name: "Quick search" })',
    );
  });

  it("adds a unique structural CSS fallback for duplicate semantic locators", () => {
    document.body.innerHTML = `
      <nav><a href="/docs/writing-tests">Writing tests</a></nav>
      <main><a href="/docs/writing-tests">Writing tests</a></main>
    `;
    const target = document.querySelector("main a");
    if (!(target instanceof HTMLAnchorElement)) {
      throw new Error("duplicate link fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "writing-tests",
      locationHref: "https://example.test/docs",
    });
    const structural = attachment.locatorBundle.candidates.find(
      (candidate) => candidate.strategy === "css" && candidate.notes === "structural fallback",
    );

    expect(structural).toBeDefined();
    expect(document.querySelectorAll(structural?.value ?? "")).toHaveLength(1);
    expect(document.querySelector(structural?.value ?? "")).toBe(target);
    expect(structural?.value).not.toContain("Writing tests");
    expect(structural?.value).not.toContain("/docs/writing-tests");
    expect(attachment.locatorBundle.stability.score).toBe(72);
  });

  it("uses a unique data attribute name without exposing its value", () => {
    document.body.innerHTML = `
      <strong data-tibo-time-clock="private-runtime-value">07:13:13</strong>
      <strong data-state="active">Unrelated</strong>
    `;
    const target = document.querySelector("[data-tibo-time-clock]");
    if (!(target instanceof HTMLElement)) {
      throw new Error("dynamic clock fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "dynamic-clock",
      locationHref: "https://example.test/feed",
    });

    expect(attachment.context.selectorHints).toContain("[data-tibo-time-clock]");
    expect(attachment.locatorBundle.candidates).toContainEqual(expect.objectContaining({
      strategy: "css",
      value: "[data-tibo-time-clock]",
      notes: "stable data attribute",
    }));
    expect(JSON.stringify(attachment)).not.toContain("private-runtime-value");
    expect(attachment.context.selectorHints).not.toContain("[data-state]");
  });

  it("anchors a dynamic descendant to a unique stable ancestor", () => {
    document.body.innerHTML = `
      <div data-tibo-time>
        <div class="tibo-time-copy">
          <div class="tibo-time-row"><strong>07:13:13</strong><span>8月4日 周二</span></div>
          <div class="tibo-time-detail">旧金山湾区 / PT</div>
        </div>
      </div>
    `;
    const target = document.querySelector(".tibo-time-copy");
    if (!(target instanceof HTMLElement)) {
      throw new Error("dynamic container fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "dynamic-container",
      locationHref: "https://example.test/feed",
    });
    const anchored = attachment.locatorBundle.candidates.find(
      (candidate) => candidate.notes === "anchored structural fallback",
    );

    expect(anchored).toBeDefined();
    expect(anchored?.value).toMatch(/^\[data-tibo-time\] > /);
    expect(document.querySelectorAll(anchored?.value ?? "")).toHaveLength(1);
    expect(document.querySelector(anchored?.value ?? "")).toBe(target);
  });

  it("scopes a repeated dynamic action to a unique descendant link anchor", () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/1952521961831320123">First post</a>
        <div><div><div><div><div><div><div><div>
          <button data-testid="like">7013 Likes</button>
        </div></div></div></div></div></div></div></div>
      </article>
      <article data-testid="tweet">
        <a href="/alice/status/222">Second post</a>
        <div><div><div><div><div><div><div><div>
          <button data-testid="like">42 Likes</button>
        </div></div></div></div></div></div></div></div>
      </article>
    `;
    const target = document.querySelector(
      'article:has(a[href="/alice/status/1952521961831320123"]) button',
    );
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error("repeated action fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "first-like",
      locationHref: "https://example.test/alice",
    });
    const anchored = attachment.locatorBundle.candidates.find(
      (candidate) => candidate.notes === "descendant anchored fallback",
    );

    expect(anchored).toBeDefined();
    expect(anchored?.value).toContain(
      'article:has(a[href="/alice/status/1952521961831320123"])',
    );
    expect(anchored?.value).toContain('[data-testid="like"]');
    expect(document.querySelectorAll(anchored?.value ?? "")).toHaveLength(1);
    expect(document.querySelector(anchored?.value ?? "")).toBe(target);
  });

  it("anchors an interactive target even before its label changes", () => {
    document.body.innerHTML = `
      <article>
        <a href="/items/stable-item">Stable item</a>
        <button data-testid="follow">Follow</button>
      </article>
      <article>
        <a href="/items/another-item">Another item</a>
        <button data-testid="follow">Follow</button>
      </article>
    `;
    const target = document.querySelector('article:has(a[href="/items/stable-item"]) button');
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error("interactive content target fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "stable-follow",
      locationHref: "https://example.test/items",
    });

    expect(attachment.locatorBundle.candidates).toContainEqual(expect.objectContaining({
      strategy: "css",
      value: 'article:has(a[href="/items/stable-item"]) [data-testid="follow"]',
      notes: "descendant anchored fallback",
    }));
  });

  it("does not raise stability when structural CSS is the only locator before coordinates", () => {
    document.body.innerHTML = `
      <section><span></span></section>
      <section><span></span></section>
    `;
    const target = document.querySelectorAll("span")[1];
    if (!(target instanceof HTMLSpanElement)) {
      throw new Error("structural-only fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "structural-only",
      locationHref: "https://example.test/structure",
    });

    expect(attachment.locatorBundle.primary).toEqual(
      expect.objectContaining({ strategy: "css", notes: "structural fallback" }),
    );
    expect(attachment.locatorBundle.stability.score).toBe(14);
  });

  it("continues past a unique bare tag to produce a structural CSS locator", () => {
    document.body.innerHTML = "<section><span></span></section>";
    const target = document.querySelector("span");
    if (!(target instanceof HTMLSpanElement)) {
      throw new Error("unique bare-tag fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "unique-bare-tag",
      locationHref: "https://example.test/structure",
    });

    expect(attachment.locatorBundle.primary).toEqual({
      strategy: "css",
      value: "section > span",
      confidence: 0.55,
      notes: "structural fallback",
    });
    expect(document.querySelector(attachment.locatorBundle.primary?.value ?? "")).toBe(target);
  });

  it("omits structural fallbacks when sibling discovery exceeds its budget", () => {
    const wideSiblings = Array.from({ length: 1_001 }, () => "<div></div>").join("");
    document.body.innerHTML = `
      <section><input aria-label="Target">${wideSiblings}</section>
      <section><input aria-label="Other"></section>
    `;
    const target = document.querySelector("section input");
    if (!(target instanceof HTMLInputElement)) {
      throw new Error("wide sibling fixture missing");
    }

    const attachment = extractElementAttachment(target, {
      idSeed: "wide-siblings",
      locationHref: "https://example.test/wide",
    });

    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "css", notes: "structural fallback" }),
    );
  });

  it("does not emit a textbox role locator for password inputs", () => {
    document.body.innerHTML = `
      <label for="password">Password</label>
      <input id="password" type="password" data-testid="password-input">
    `;
    const input = document.querySelector("#password");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("password input fixture missing");
    }

    const attachment = extractElementAttachment(input, {
      idSeed: "password-input",
      locationHref: "https://example.test/login",
    });

    expect(attachment.element).toMatchObject({
      role: null,
      accessibleName: "Password",
    });
    expect(attachment.locatorBundle.primary).toMatchObject({
      strategy: "playwright.label",
      value: 'page.getByLabel("Password")',
    });
    expect(attachment.locatorBundle.candidates).not.toContainEqual(
      expect.objectContaining({ strategy: "playwright.role" }),
    );
  });

  it("resolves native form labels within the control shadow root", () => {
    document.body.innerHTML = `
      <label for="email">Unrelated light label</label>
      <div id="shadow-host"></div>
    `;
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const label = document.createElement("label");
    label.htmlFor = "email";
    label.textContent = "Shadow email";
    const input = document.createElement("input");
    input.id = "email";
    input.type = "email";
    shadowRoot.append(label, input);

    const attachment = extractElementAttachment(input, {
      idSeed: "shadow-email",
      locationHref: "https://example.test/form",
    });

    expect(attachment.element.accessibleName).toBe("Shadow email");
    expect(attachment.locatorBundle.candidates).toContainEqual(
      expect.objectContaining({
        strategy: "playwright.label",
        value: 'page.getByLabel("Shadow email")',
      }),
    );
  });

  it("uses an input button value as its accessible name", () => {
    document.body.innerHTML = '<input type="submit" value="Save changes">';
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("submit input fixture missing");
    }

    const attachment = extractElementAttachment(input, {
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      idSeed: "submit-input",
      locationHref: "https://example.test/form",
      documentTitle: "Form",
    });

    expect(attachment.element).toMatchObject({
      role: "button",
      accessibleName: "Save changes",
    });
    expect(attachment.locatorBundle.primary).toMatchObject({
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Save changes" })',
    });
  });

  it("honors inherited fieldset disabled state and the first-legend exception", () => {
    document.body.innerHTML = `
      <fieldset disabled>
        <legend><button id="legend-action">Legend action</button></legend>
        <button id="form-action">Form action</button>
      </fieldset>
    `;
    const legendAction = document.querySelector("#legend-action");
    const formAction = document.querySelector("#form-action");
    if (!(legendAction instanceof HTMLButtonElement) || !(formAction instanceof HTMLButtonElement)) {
      throw new Error("disabled fieldset fixture missing");
    }

    const legendAttachment = extractElementAttachment(legendAction, {
      idSeed: "legend-action",
      locationHref: "https://example.test/form",
    });
    const formAttachment = extractElementAttachment(formAction, {
      idSeed: "form-action",
      locationHref: "https://example.test/form",
    });

    expect(legendAttachment.element.enabled).toBe(true);
    expect(formAttachment.element.enabled).toBe(false);
  });

  it("accounts for opacity on light and shadow ancestors", () => {
    document.body.innerHTML = `
      <div id="light-parent" style="opacity: 0"><button>Light action</button></div>
      <div id="shadow-host" style="opacity: 0"></div>
    `;
    const lightButton = document.querySelector("#light-parent button");
    const host = document.querySelector("#shadow-host");
    if (!(lightButton instanceof HTMLButtonElement) || !(host instanceof HTMLElement)) {
      throw new Error("opacity fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const shadowButton = document.createElement("button");
    shadowButton.textContent = "Shadow action";
    shadowRoot.append(shadowButton);
    const visibleRect = {
      x: 0,
      y: 0,
      width: 100,
      height: 32,
      top: 0,
      left: 0,
      right: 100,
      bottom: 32,
      toJSON: () => ({}),
    } as DOMRect;
    lightButton.getBoundingClientRect = () => visibleRect;
    shadowButton.getBoundingClientRect = () => visibleRect;

    const lightAttachment = extractElementAttachment(lightButton, {
      idSeed: "light-opacity",
      locationHref: "https://example.test/form",
    });
    const shadowAttachment = extractElementAttachment(shadowButton, {
      idSeed: "shadow-opacity",
      locationHref: "https://example.test/form",
    });

    expect(lightAttachment.element.visible).toBe(false);
    expect(shadowAttachment.element.visible).toBe(false);
  });

  it("resolves aria-labelledby inside the selected element shadow root", () => {
    document.body.innerHTML = '<div id="shadow-host"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const label = document.createElement("span");
    label.id = "shadow-label";
    label.textContent = "Confirm purchase";
    const button = document.createElement("button");
    button.setAttribute("aria-labelledby", label.id);
    shadowRoot.append(label, button);

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      idSeed: "shadow-labelled",
      locationHref: "https://example.test/checkout",
      documentTitle: "Checkout",
    });

    expect(attachment.element.accessibleName).toBe("Confirm purchase");
    expect(attachment.locatorBundle.primary).toMatchObject({
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Confirm purchase" })',
    });
  });

  it("redacts sensitive values across a direct agent-safe capture", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <button
            data-testid="sk-test-1234567890"
            role="button sk-test-1234567890"
            aria-label="Invite ada@example.com"
          >Invite</button>
          <p>Contact ada@example.com with token sk-test-1234567890</p>
        </section>
      </main>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/team",
      documentTitle: "Team ada@example.com",
    });

    expect(attachment.source.title).toBe("Team [redacted:email]");
    expect(attachment.id).not.toContain("sk-test-1234567890");
    expect(attachment.element.role).toBe("button [redacted:secret]");
    expect(attachment.element.accessibleName).toBe("Invite [redacted:email]");
    expect(attachment.context.nearbyText).toContain(
      "Contact [redacted:email] with token [redacted:secret]",
    );
    expect(JSON.stringify(attachment)).not.toContain("ada@example.com");
    expect(JSON.stringify(attachment)).not.toContain("sk-test-1234567890");
    expect(attachment.policy.redactedFields).toContain("context.nearbyText");
    expect(attachment.policy.redactedFields).toContain("element.role");
    expect(attachment.policy.sensitiveHints).toContain("context.nearbyText");
    expect(attachment.policy.includedSensitiveFields).not.toContain("context.nearbyText");
  });

  it("redacts sensitive element ids before and after CSS selector escaping", () => {
    const sensitiveId = "ada@example.com";
    document.body.innerHTML = `<button id="${sensitiveId}">Open profile</button>`;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("sensitive id fixture missing");
    }

    const agentSafe = extractElementAttachment(button, {
      idSeed: "safe-id",
      locationHref: "https://example.test/profile",
    });
    const fullDebug = extractElementAttachment(button, {
      idSeed: "debug-id",
      locationHref: "https://example.test/profile",
      disclosureMode: "full_debug",
    });
    const derived = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(JSON.stringify(agentSafe)).not.toContain(sensitiveId);
    expect(JSON.stringify(agentSafe)).not.toContain("ada\\\\@example\\\\.com");
    expect(agentSafe.policy.redactedFields).toEqual(
      expect.arrayContaining(["context.selectorHints", "locatorBundle.candidates"]),
    );
    expect(JSON.stringify(fullDebug)).toContain("ada\\\\@example\\\\.com");
    expect(fullDebug.policy.includedSensitiveFields).toEqual(
      expect.arrayContaining(["context.selectorHints", "locatorBundle.candidates"]),
    );
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(JSON.stringify(derived.attachment)).not.toContain(sensitiveId);
    expect(JSON.stringify(derived.attachment)).not.toContain("ada\\\\@example\\\\.com");
  });

  it("redacts common credential and payment patterns in agent-safe text", () => {
    const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
    const password = "password: CorrectHorseBatteryStaple!";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const paymentCard = "4242 4242 4242 4242";
    document.body.innerHTML = `
      <main>
        <section>
          <button>Inspect account</button>
          <p>${bearer}</p>
          <p>${password}</p>
          <p>AWS access key: ${awsKey}</p>
          <p>Card: ${paymentCard}</p>
        </section>
      </main>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/account",
      documentTitle: "Account",
    });
    const serialized = JSON.stringify(attachment);

    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain("CorrectHorseBatteryStaple!");
    expect(serialized).not.toContain(awsKey);
    expect(serialized).not.toContain(paymentCard);
    expect(attachment.context.nearbyText.join(" ")).toContain("[redacted:secret]");
    expect(attachment.context.nearbyText.join(" ")).toContain("[redacted:payment-card]");
    expect(attachment.policy.redactedFields).toContain("context.nearbyText");
    expect(attachment.policy.sensitiveHints).toContain("context.nearbyText");
  });

  it("audits common sensitive patterns retained by full debug disclosure", () => {
    const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
    document.body.innerHTML = `
      <main>
        <section>
          <button>Inspect account</button>
          <p>${bearer}</p>
        </section>
      </main>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/account",
      documentTitle: "Account",
      disclosureMode: "full_debug",
    });

    expect(attachment.context.nearbyText.join(" ")).toContain(bearer);
    expect(attachment.policy.includedSensitiveFields).toContain("context.nearbyText");
    expect(attachment.policy.sensitiveHints).toContain("context.nearbyText");
  });

  it("preserves ordinary UI copy that only resembles credential labels", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <button aria-label="Bearer bonds">Bearer bonds</button>
          <p>Token: active</p>
          <p>Password: required</p>
        </section>
      </main>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/bonds",
      documentTitle: "Bonds",
    });

    expect(attachment.element.text).toBe("Bearer bonds");
    expect(attachment.element.accessibleName).toBe("Bearer bonds");
    expect(attachment.context.nearbyText).toEqual(
      expect.arrayContaining(["Token: active", "Password: required"]),
    );
    expect(attachment.locatorBundle.primary?.value).toContain("Bearer bonds");
    expect(JSON.stringify(attachment)).not.toContain("[redacted:secret]");
  });

  it("redacts URL query and hash fragments by default", () => {
    document.body.innerHTML = `
      <main>
        <button data-testid="save-button">Save</button>
      </main>
    `;
    const button = document.querySelector("[data-testid='save-button']");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/settings/sk-test-1234567890?token=secret#billing",
      documentTitle: "Settings",
    });

    expect(attachment.source.url).toBe(
      "https://example.test/settings/[redacted:secret]",
    );
    expect(attachment.source.url).not.toContain("sk-test-1234567890");
    expect(attachment.source.url).not.toContain("token=secret");
    expect(attachment.source.url).not.toContain("billing");
    expect(attachment.policy.redactedFields).toContain("source.url");
    expect(attachment.policy.sensitiveHints).toContain("source.url");
    expect(attachment.policy.includedSensitiveFields).not.toContain("source.url");
  });

  it("collects ancestor context when an action is nested in a button row", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <h2>Dummy sensitive workspace</h2>
          <p>All values in this section are fake.</p>
          <p>Owner email: ada@example.com</p>
          <p>API token: sk-test-1234567890</p>
          <div class="actions">
            <button data-testid="rotate-demo-secret">Rotate demo secret</button>
            <button>Copy billing note</button>
          </div>
        </section>
      </main>
    `;
    const button = document.querySelector("[data-testid='rotate-demo-secret']");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/team",
      documentTitle: "Team",
    });

    expect(attachment.context.nearbyText).toContain("Owner email: [redacted:email]");
    expect(attachment.context.nearbyText).toContain("API token: [redacted:secret]");
    expect(attachment.policy.redactedFields).toContain("context.nearbyText");
    expect(attachment.policy.sensitiveHints).toContain("context.nearbyText");
  });

  it("keeps sensitive fields when full debug disclosure is explicitly requested", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <button data-testid="sk-test-1234567890">Invite</button>
          <p>Contact ada@example.com with token sk-test-1234567890</p>
        </section>
      </main>
    `;
    const button = document.querySelector("[data-testid='sk-test-1234567890']");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const attachment = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/team?token=secret#members",
      documentTitle: "Team ada@example.com",
      disclosureMode: "full_debug",
    });

    expect(attachment.source.url).toBe("https://example.test/team?token=secret#members");
    expect(attachment.source.title).toBe("Team ada@example.com");
    expect(attachment.id).toContain("sk-test-1234567890");
    expect(attachment.context.selectorHints.join(" ")).toContain("sk-test-1234567890");
    expect(attachment.locatorBundle.candidates.map((candidate) => candidate.value).join(" ")).toContain(
      "sk-test-1234567890",
    );
    expect(attachment.context.nearbyText).toContain(
      "Contact ada@example.com with token sk-test-1234567890",
    );
    expect(attachment.policy).toMatchObject({
      disclosureMode: "full_debug",
      redactionLevel: "debug",
    });
    expect(attachment.policy.redactedFields).toEqual([]);
    expect(attachment.policy.sensitiveHints).toEqual(
      expect.arrayContaining([
        "attachment.id",
        "context.nearbyText",
        "context.selectorHints",
        "locatorBundle.candidates",
        "source.title",
        "source.url",
      ]),
    );
    expect(attachment.policy.includedSensitiveFields).toEqual(
      expect.arrayContaining([
        "attachment.id",
        "context.nearbyText",
        "context.selectorHints",
        "locatorBundle.candidates",
        "source.title",
        "source.url",
      ]),
    );
  });

  it("derives an agent-safe attachment from a full debug attachment", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <button data-testid="sk-test-1234567890">Invite ada@example.com</button>
          <p>Contact ada@example.com with token sk-test-1234567890</p>
        </section>
      </main>
    `;
    const button = document.querySelector("[data-testid='sk-test-1234567890']");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/team?token=secret#members",
      documentTitle: "Team ada@example.com",
      disclosureMode: "full_debug",
    });
    fullDebug.locatorBundle.stability = {
      ...fullDebug.locatorBundle.stability,
      replayVerified: true,
      verifiedBy: "playwright.testId",
      verifiedValue: 'page.getByTestId("sk-test-1234567890")',
    };
    fullDebug.artifacts = {
      screenshotCrop: "data:image/png;base64,full-debug-crop",
      overlayImage: "data:image/png;base64,full-debug-overlay",
    };
    fullDebug.policy = {
      ...fullDebug.policy,
      allowScreenshot: true,
      allowDomSnippet: true,
      allowNetworkSend: true,
      allowedDomains: ["https://agent.example.test"],
    };

    const diagnosticResult = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const result = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const fullDebugResult = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnosticResult.ok).toBe(true);
    if (diagnosticResult.ok) {
      expect(diagnosticResult.attachment.source.url).toBe("[redacted:declared-sensitive]");
      expect(diagnosticResult.attachment.source.title).toBe("[redacted:declared-sensitive]");
      expect(diagnosticResult.attachment.artifacts).toEqual({
        screenshotCrop: null,
        overlayImage: null,
      });
      expect(diagnosticResult.attachment.policy).toMatchObject({
        allowScreenshot: false,
        allowDomSnippet: false,
        allowNetworkSend: false,
        allowedDomains: [],
      });
      expect(JSON.stringify(diagnosticResult.attachment)).not.toContain("ada@example.com");
      expect(JSON.stringify(diagnosticResult.attachment)).not.toContain(
        "sk-test-1234567890",
      );
    }

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.attachment.source.url).toBeNull();
    expect(result.attachment.source.title).toBe("[redacted:declared-sensitive]");
    expect(result.attachment.id).not.toContain("sk-test-1234567890");
    expect(result.attachment.element.text).toBe("[redacted:declared-sensitive]");
    expect(result.attachment.element.accessibleName).toBe("[redacted:declared-sensitive]");
    expect(result.attachment.context.nearbyText).toEqual([]);
    expect(result.attachment.context.selectorHints).toEqual([]);
    expect(result.attachment.locatorBundle.primary).toBeNull();
    expect(result.attachment.locatorBundle.stability.verifiedValue).toBeNull();
    expect(result.attachment.artifacts).toEqual({
      screenshotCrop: null,
      overlayImage: null,
    });
    expect(JSON.stringify(result.attachment)).not.toContain("ada@example.com");
    expect(JSON.stringify(result.attachment)).not.toContain("sk-test-1234567890");
    expect(fullDebug.source.title).toBe("Team ada@example.com");
    expect(fullDebug.artifacts.screenshotCrop).toBe(
      "data:image/png;base64,full-debug-crop",
    );
    expect(result.attachment.policy).toMatchObject({
      disclosureMode: "agent_safe",
      redactionLevel: "strict",
      allowScreenshot: false,
      allowDomSnippet: false,
      allowNetworkSend: false,
      allowedDomains: [],
      redactedFields: [
        "artifacts.overlayImage",
        "artifacts.screenshotCrop",
        "attachment.id",
        "context.nearbyText",
        "context.selectorHints",
        "element.accessibleName",
        "element.text",
        "locatorBundle.candidates",
        "locatorBundle.stability.verifiedValue",
        "source.title",
        "source.url",
      ],
      sensitiveHints: [
        "artifacts.overlayImage",
        "artifacts.screenshotCrop",
        "attachment.id",
        "context.nearbyText",
        "context.selectorHints",
        "element.accessibleName",
        "element.text",
        "locatorBundle.candidates",
        "locatorBundle.stability.verifiedValue",
        "source.title",
        "source.url",
      ],
      includedSensitiveFields: [],
    });
    expect(fullDebugResult.ok).toBe(true);
    if (fullDebugResult.ok) {
      expect(fullDebugResult.attachment.policy).toMatchObject({
        allowScreenshot: true,
        allowDomSnippet: true,
        allowNetworkSend: true,
        allowedDomains: ["https://agent.example.test"],
      });
    }
  });

  it("preserves diagnostic URL context while redacting recognized URL secrets", () => {
    document.body.innerHTML = '<button type="button">Inspect callback</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const secretUrl =
      "https://alice:hunter2hunter2@localhost/callback/http://ivan:pa%2Fss%3Fxx%23yy%5Czz%20qq@localhost/literal/http%3A%2F%2Fheidi%3Apass%40localhost%2Fpath?http://frank:pass@localhost/key&access_token=sk-test-1234567890&next=http://bob:hunter@localhost/inside; next=http://alice:secret@localhost/two&next=http://carol:pa,ss@localhost/three&next=http://dave:pa;ss@localhost/four&next=http://eve:pass@localhost\\path@label#bad=%ZZ&next=http%3A%2F%2Fgrace%3Apass%40localhost%2Fhash";
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: secretUrl,
      documentTitle: "Callback",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    expect(diagnostic.attachment.policy.redactedFields).toContain("source.url");
    expect(diagnostic.attachment.policy.includedSensitiveFields).not.toContain("source.url");
    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }
    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
    const fullDebugUrl = new URL(fullDebug.source.url ?? "");
    expect(fullDebugUrl.username).toBe("alice");
    expect(fullDebugUrl.password).toBe("hunter2hunter2");
    expect(decodeURIComponent(fullDebugUrl.pathname)).toContain(
      "http://ivan:pa/ss?xx#yy\\zz qq@localhost/literal/",
    );
    expect(decodeURIComponent(fullDebugUrl.pathname)).toContain(
      "http://heidi:pass@localhost/path",
    );
    expect(fullDebugUrl.searchParams.has("http://frank:pass@localhost/key")).toBe(true);
    expect(fullDebugUrl.searchParams.getAll("next")).toEqual([
      "http://bob:hunter@localhost/inside; next=http://alice:secret@localhost/two",
      "http://carol:pa,ss@localhost/three",
      "http://dave:pa;ss@localhost/four",
      "http://eve:pass@localhost\\path@label",
    ]);
    const fullDebugHash = new URLSearchParams(fullDebugUrl.hash.slice(1));
    expect(fullDebugHash.get("bad")).toBe("%ZZ");
    expect(fullDebugHash.get("next")).toBe("http://grace:pass@localhost/hash");
  });

  it("preserves untouched hash escapes while sanitizing encoded URL userinfo", () => {
    document.body.innerHTML = '<button type="button">Inspect hash</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/#keep=%2f%41&next=http%3A%2F%2Fbob%3Apass%40localhost%2Fhash",
      documentTitle: "Hash",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
  });

  it("sanitizes protocol-relative URL userinfo in retained URL components", () => {
    document.body.innerHTML = '<button type="button">Inspect redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback//alice:hunter2@localhost/path?next=//bob:pass@localhost/query#next=//carol:secret@localhost/hash",
      documentTitle: "Redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    expect(diagnostic.attachment.policy.redactedFields).toContain("source.url");

    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }

    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("sanitizes encoded protocol-relative URL userinfo while preserving adjacent values", () => {
    document.body.innerHTML = '<button type="button">Inspect encoded redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback/%2F%2Falice%3Apass%40localhost%2Fpath?keep=%2f%41&next=%2F%2Fbob%3Apass%40localhost%2Fquery#keep=%2f%42&next=%2F%2Fcarol%3Apass%40localhost%2Fhash",
      documentTitle: "Encoded redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
  });

  it("preserves ordinary double slashes that do not contain URL userinfo", () => {
    document.body.innerHTML = '<button type="button">Inspect route</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/docs//team/path?note=ratio//value#anchor//section",
      documentTitle: "Route",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
  });

  it("sanitizes userinfo in malformed absolute URLs normalized by WHATWG", () => {
    document.body.innerHTML = '<button type="button">Inspect malformed redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback/http:///alice:hunter2@localhost/path/http:%2F%2F%2Fbob%3Apass%40localhost%2Fencoded",
      documentTitle: "Malformed redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(decodeURIComponent(new URL(diagnostic.attachment.source.url ?? "").pathname)).toBe(
      "/callback/http:///localhost/path/http:///localhost/encoded",
    );
    expect(diagnostic.attachment.source.url).not.toMatch(/alice|bob|hunter2|pass/);

    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(decodeURIComponent(new URL(agentSafe.attachment.source.url ?? "").pathname)).toBe(
        "/callback/http:///localhost/path/http:///localhost/encoded",
      );
    }

    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("sanitizes userinfo when malformed source text cannot be parsed as a URL", () => {
    document.body.innerHTML = '<button type="button">Inspect proxied URL</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const malformedUrl =
      "proxied https://alice:hunter@localhost/path?keep=value#section";
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: malformedUrl,
      documentTitle: "Proxied URL",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    expect(diagnostic.attachment.policy.redactedFields).toContain("source.url");
    expect(agentSafe.ok).toBe(true);
    if (!agentSafe.ok) return;
    expect(agentSafe.attachment.source.url).toBeNull();
    expect(JSON.stringify(agentSafe.attachment)).not.toMatch(/alice|hunter/);
    expect(fullDebug.source.url).toBe(malformedUrl);
  });

  it("sanitizes WHATWG special-scheme URLs without double-slash separators", () => {
    document.body.innerHTML = '<button type="button">Inspect special URL</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback/http:alice:secret@localhost/one/http:/bob:pass@localhost/two/http:%5Ccarol:pass@localhost/three?next=http:dave:pass@localhost/query#next=http:%5Ceve:pass@localhost/hash",
      documentTitle: "Special URL",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");

    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }

    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("does not match http inside another URL scheme token", () => {
    document.body.innerHTML = '<button type="button">Inspect custom URL</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback/xhttp:alice:pass@localhost/path?next=x-http:bob:pass@localhost/query#next=x+http:carol:pass@localhost/hash",
      documentTitle: "Custom URL",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }
    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("sanitizes non-HTTP special schemes and backslash network paths", () => {
    document.body.innerHTML = '<button type="button">Inspect special schemes</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback/ws://alice:pass@localhost/socket/ftp:bob:pass@localhost/file/%5C%5Ccarol:pass@localhost/path?next=wss://dave:pass@localhost/socket&unc=%5C%5Ceve:pass@localhost/path#next=ftp://frank:pass@localhost/file",
      documentTitle: "Special schemes",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");

    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }
    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("sanitizes encoded URL userinfo containing encoded authority delimiters", () => {
    document.body.innerHTML = '<button type="button">Inspect encoded credentials</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback?next=http%3A%2F%2Falice%3Apa%2Fss%3Fxx%23yy%5Czz%40localhost%2Fpath",
      documentTitle: "Encoded credentials",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }

    for (const encodedValue of [
      "http%3A%2F%2Falice%3A1234%2Fss%40localhost%2Fpath",
      "http%3A%2F%2Falice%3A1234%2Fpa%26%2F%2Fx%40localhost%2Fpath",
    ]) {
      const ambiguousFullDebug = extractElementAttachment(button, {
        now: () => new Date("2026-07-02T00:00:00.000Z"),
        locationHref: `https://example.test/callback?value=${encodedValue}`,
        documentTitle: "Ambiguous encoded credentials",
        disclosureMode: "full_debug",
      });
      const ambiguousDiagnostic = deriveAttachmentDisclosure(
        ambiguousFullDebug,
        "developer_diagnostic",
      );

      expect(ambiguousDiagnostic.ok).toBe(true);
      if (ambiguousDiagnostic.ok) {
        expect(ambiguousDiagnostic.attachment.source.url).toBe(
          "[redacted:declared-sensitive]",
        );
      }
    }
  });

  it("preserves encoded URL paths containing email-like at signs", () => {
    document.body.innerHTML = '<button type="button">Inspect encoded path</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback?next=http%3A%2F%2Fhost%2Fusers%2Falice%40example.com&route=http%3A%2F%2Fhost%2Fpath&email=a@b.test#next=http%3A%2F%2Fhost%2Fusers%2Fbob%40example.com",
      documentTitle: "Encoded path",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
  });

  it("distinguishes encoded empty-user credentials from IPv6 and file paths", () => {
    document.body.innerHTML = '<button type="button">Inspect encoded authorities</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    for (const [name, encodedValue, expectedValue] of [
      ["credential", "http%3A%2F%2F%3Apass%2Fss%40localhost%2Fpath", "http://localhost/path"],
      ["numeric", "http%3A%2F%2F%3A1234%2Fss%40localhost%2Fpath", "http://localhost/path"],
      [
        "bracketed",
        "http%3A%2F%2F%5Balice%5D%3A1234%2Fss%40localhost%2Fpath",
        "http://localhost/path",
      ],
      [
        "ipv6",
        "http%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D%3A8080%2Fusers%2Falice%40example.com",
        "http://[2001:db8::1]:8080/users/alice@example.com",
      ],
      [
        "ipv6-empty",
        "http%3A%2F%2F%5B%3A%3A1%5D%3A%2Fusers%2Fcarol%40example.com",
        "http://[::1]:/users/carol@example.com",
      ],
      ["file", "file%3A%2F%2F%2FC%3A%2FUsers%2Fbob%40example.com", "file:///C:/Users/bob@example.com"],
    ] as const) {
      const fullDebug = extractElementAttachment(button, {
        now: () => new Date("2026-07-02T00:00:00.000Z"),
        locationHref: `https://example.test/callback?${name}=${encodedValue}`,
        documentTitle: "Encoded authorities",
        disclosureMode: "full_debug",
      });

      const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

      expect(diagnostic.ok).toBe(true);
      if (!diagnostic.ok) continue;
      if (diagnostic.attachment.source.url === "[redacted:declared-sensitive]") {
        continue;
      }
      expect(new URL(diagnostic.attachment.source.url ?? "").searchParams.get(name)).toBe(
        expectedValue,
      );
    }
  });

  it("fails closed for ambiguous hash parameter and URL userinfo boundaries", () => {
    document.body.innerHTML = '<button type="button">Inspect hash parameters</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }

    for (const hash of [
      "next=//host&email=a@b.test",
      "next=//alice&email=token@localhost/path",
      "next=//host:8080&email=a@b.test",
      "next=//alice&team=blue&email=token@localhost/path",
    ]) {
      const fullDebug = extractElementAttachment(button, {
        now: () => new Date("2026-07-02T00:00:00.000Z"),
        locationHref: `https://example.test/#${hash}`,
        documentTitle: "Hash parameters",
        disclosureMode: "full_debug",
      });

      const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
      const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

      expect(diagnostic.ok).toBe(true);
      if (diagnostic.ok) {
        expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
      }
      expect(retainedFullDebug.ok).toBe(true);
      if (retainedFullDebug.ok) {
        expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
      }
    }
  });

  it("sanitizes raw ampersands inside hash URL userinfo", () => {
    document.body.innerHTML = '<button type="button">Inspect hash redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/#next=//alice:pa&ss@localhost/path",
      documentTitle: "Hash redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }
    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("fails closed before raw query separators can split ambiguous URL userinfo", () => {
    document.body.innerHTML = '<button type="button">Inspect query redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }

    for (const search of [
      "next=//apiToken&rest@internal/path=1",
      "next=//u@ser:pa&ss@localhost/path=1",
      "next=//u@ser:1234&hunter2@localhost/path=1",
      "next=//alice:pa&hunter2hunter2@localhost/path",
      "next=//alice:pa&x=1&ss@localhost/path=1",
      "next=//host&email=a@b.test",
      "next=http%3A%2F%2Falice%3A1234%2Fpa&ss%40localhost%2Fpath=1",
      "next=http%3A%2F%2Falice%3A1234%2Fpa&%2F%2Fx%40localhost%2Fpath=1",
      "next=http%3A%2F%2Falice%3A1234%2Fpa&&ss%40localhost%2Fpath=1",
      "next=http%3A%2F%2Falice%3A1234%2Fpa&mid&ss%40localhost%2Fpath=1",
      "next=http%3A%2F%2Falice%3A1234%2Fpa&x=&ss%40localhost%2Fpath=1",
      "next=//alice:pa&http://x@y@localhost/path=1",
    ]) {
      const fullDebug = extractElementAttachment(button, {
        now: () => new Date("2026-07-02T00:00:00.000Z"),
        locationHref: `https://example.test/callback?${search}`,
        documentTitle: "Query redirect",
        disclosureMode: "full_debug",
      });

      const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
      const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
      const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

      expect(diagnostic.ok).toBe(true);
      if (diagnostic.ok) {
        expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
      }
      expect(agentSafe.ok).toBe(true);
      if (agentSafe.ok) {
        expect(agentSafe.attachment.source.url).toBeNull();
      }
      expect(retainedFullDebug.ok).toBe(true);
      if (retainedFullDebug.ok) {
        expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
      }
    }
  });

  it("keeps query boundaries after a raw path terminates URL userinfo", () => {
    document.body.innerHTML = '<button type="button">Inspect completed redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const locationHref =
      "https://example.test/callback?next=http://alice:pass@host/path&email=a@b.test";
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref,
      documentTitle: "Completed redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
    expect(fullDebug.source.url).toBe(locationHref);
  });

  it("keeps independent query URL candidates separate while sanitizing each one", () => {
    document.body.innerHTML = '<button type="button">Inspect query redirects</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback?next=//localhost/one&next=//bob:pass@localhost/two",
      documentTitle: "Query redirects",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
  });

  it("preserves path colons outside raw-query URL authorities", () => {
    document.body.innerHTML = '<button type="button">Inspect query boundaries</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const cases = [
      {
        search: "next=http://host/path:tag&ss@localhost/path=1",
        next: "http://host/path:tag",
        extraKey: "ss@localhost/path",
        extraValue: "1",
      },
      {
        search: "next=file:///C:/tmp&ss@localhost/path=1",
        next: "file:///C:/tmp",
        extraKey: "ss@localhost/path",
        extraValue: "1",
      },
      {
        search: "next=http://host%2Fpath%3Atag&ss%40localhost%2Fpath=1",
        next: "http://host/path:tag",
        extraKey: "ss@localhost/path",
        extraValue: "1",
      },
      {
        search: "next=file:///C:%2Ftmp&ss%40localhost%2Fpath=1",
        next: "file:///C:/tmp",
        extraKey: "ss@localhost/path",
        extraValue: "1",
      },
    ];

    for (const testCase of cases) {
      const fullDebug = extractElementAttachment(button, {
        now: () => new Date("2026-07-02T00:00:00.000Z"),
        locationHref: `https://example.test/callback?${testCase.search}`,
        documentTitle: "Query boundaries",
        disclosureMode: "full_debug",
      });
      const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

      expect(diagnostic.ok).toBe(true);
      if (!diagnostic.ok) continue;
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
  });

  it("sanitizes raw query URL userinfo before encoded delimiters are decoded", () => {
    document.body.innerHTML = '<button type="button">Inspect encoded query redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback?next=http://ivan:pa%2Fss%3Fxx%23yy@localhost/path",
      documentTitle: "Encoded query redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");
    const agentSafe = deriveAttachmentDisclosure(fullDebug, "agent_safe");
    const retainedFullDebug = deriveAttachmentDisclosure(fullDebug, "full_debug");

    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    }
    expect(agentSafe.ok).toBe(true);
    if (agentSafe.ok) {
      expect(agentSafe.attachment.source.url).toBeNull();
    }
    expect(retainedFullDebug.ok).toBe(true);
    if (retainedFullDebug.ok) {
      expect(retainedFullDebug.attachment.source.url).toBe(fullDebug.source.url);
    }
  });

  it("fails closed when an embedded URL authority contains another scheme", () => {
    document.body.innerHTML = '<button type="button">Inspect redirect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback?next=http://user@name:http%3A%2F%2Fpass@localhost/path",
      documentTitle: "Redirect",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
    expect(diagnostic.attachment.policy.redactedFields).toContain("source.url");
    expect(fullDebug.source.url).toContain("user@name:http%3A%2F%2Fpass@localhost");
  });

  it("sanitizes a later URL without redacting a preceding URL that has no userinfo", () => {
    document.body.innerHTML = '<button type="button">Inspect redirects</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref:
        "https://example.test/callback?next=http://localhost/one; next=http://user:pass@localhost/two",
      documentTitle: "Redirects",
      disclosureMode: "full_debug",
    });

    const diagnostic = deriveAttachmentDisclosure(fullDebug, "developer_diagnostic");

    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) return;
    expect(diagnostic.attachment.source.url).toBe("[redacted:declared-sensitive]");
  });

  it("disclosure-processes element tag and style strings without mutating full-debug input", () => {
    document.body.innerHTML = '<button type="button">Inspect</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    const fullDebug = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/team",
      documentTitle: "Team",
      disclosureMode: "full_debug",
    });
    fullDebug.element.tagName = "owner@example.com";
    fullDebug.style = {
      display: "sk-test-1234567890",
      color: "owner@example.com",
      backgroundColor: "token-secret-1234567890",
    };
    const before = structuredClone(fullDebug);

    for (const disclosureMode of ["agent_safe", "developer_diagnostic"] as const) {
      const result = deriveAttachmentDisclosure(fullDebug, disclosureMode);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.attachment.element.tagName).toBe("[redacted:email]");
      expect(result.attachment.style).toEqual({
        display: "[redacted:secret]",
        color: "[redacted:email]",
        backgroundColor: "[redacted:secret]",
      });
      expect(result.attachment.policy.redactedFields).toEqual(
        expect.arrayContaining([
          "element.tagName",
          "style.display",
          "style.color",
          "style.backgroundColor",
        ]),
      );
      expect(JSON.stringify(result.attachment)).not.toContain("owner@example.com");
      expect(JSON.stringify(result.attachment)).not.toContain("sk-test-1234567890");
      expect(JSON.stringify(result.attachment)).not.toContain("token-secret-1234567890");
    }

    const fullDebugResult = deriveAttachmentDisclosure(fullDebug, "full_debug");
    expect(fullDebugResult.ok).toBe(true);
    if (fullDebugResult.ok) {
      expect(fullDebugResult.attachment.element.tagName).toBe("owner@example.com");
      expect(fullDebugResult.attachment.style).toEqual(before.style);
      expect(fullDebugResult.attachment.policy.includedSensitiveFields).toEqual(
        expect.arrayContaining([
          "element.tagName",
          "style.display",
          "style.color",
          "style.backgroundColor",
        ]),
      );
    }
    expect(fullDebug).toEqual(before);
  });

  it("does not derive a full debug attachment from an agent-safe attachment", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <button data-testid="invite-button">Invite</button>
          <p>Contact ada@example.com with token sk-test-1234567890</p>
        </section>
      </main>
    `;
    const button = document.querySelector("[data-testid='invite-button']");
    if (!(button instanceof HTMLElement)) {
      throw new Error("button fixture missing");
    }
    button.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 0,
        left: 0,
        right: 80,
        bottom: 32,
        toJSON: () => ({}),
      }) as DOMRect;

    const agentSafe = extractElementAttachment(button, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      locationHref: "https://example.test/team?token=secret#members",
      documentTitle: "Team",
      disclosureMode: "agent_safe",
    });

    const result = deriveAttachmentDisclosure(agentSafe, "full_debug");

    expect(result).toEqual({
      ok: false,
      reason: "Cannot derive full_debug disclosure from agent_safe capture. Capture again with full_debug disclosure.",
    });
  });
});
