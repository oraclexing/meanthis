// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { captureElementTarget } from "./capture";

const compatibilityFixturePath = resolve("apps/demo-web/public/compatibility-fixtures.html");

describe("captureElementTarget", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  test("extracts a redacted origin-scoped capture record from a confirmed target", async () => {
    document.body.innerHTML = '<button data-testid="save">Save changes</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("fixture button missing");
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
    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/settings?token=secret#billing",
      documentTitle: "Settings",
      tabId: 5,
      frameId: 0,
      selectionPoint: {
        kind: "element_relative_pointer",
        xRatio: 0.25,
        yRatio: 0.75,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.record.origin).toBe("https://app.example.com");
    expect(result.record.pageUrl).toBe("https://app.example.com/settings");
    expect(result.record.tabId).toBe(5);
    expect(result.record.frameId).toBe(0);
    expect(result.record.attachment.selectionPoint).toEqual({
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.75,
    });
    expect(result.record.attachment.source.url).toBe("https://app.example.com/settings");
    expect(result.record.attachment.policy.allowedDomains).toEqual(["https://app.example.com"]);
    expect(result.record.attachment.policy.disclosureMode).toBe("agent_safe");
    expect(result.record.attachment.policy.allowNetworkSend).toBe(false);
    expect(result.record.attachment.policy.redactedFields).toContain("source.url");
    expect(result.record.attachment.policy.sensitiveHints).toContain("source.url");
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      verifiedBy: "playwright.role",
      verifiedValue: "page.getByRole(\"button\", { name: \"Save changes\" })",
      failureReason: null,
    });
    expect(result.record.replayAttempts).toEqual([
      expect.objectContaining({
        strategy: "playwright.role",
        replayVerified: true,
        matchCount: 1,
        visible: true,
      }),
      expect.objectContaining({
        strategy: "playwright.testId",
        value: 'page.getByTestId("save")',
        replayVerified: true,
        uniqueness: true,
        matchCount: 1,
        visible: true,
      }),
    ]);
    expect(result.record.markdown).toContain("## Selected UI Element");
    expect(result.record.markdown).toContain(
      "Selection Point: 25% from left, 75% from top",
    );
    expect(result.record.markdown).toContain("- Replay Verified: true");
    expect(result.record.markdown).toContain(
      "- Verified Locator: playwright.role page.getByRole(\"button\", { name: \"Save changes\" })",
    );
    expect(result.record.summary).toContain("## Agent Quick Summary");
    expect(result.record.summary).toContain("- Target: button \"Save changes\"");
    expect(result.record.summary).toContain("- Target Tag: button");
    expect(result.record.summary).toContain("- Target Role: button");
    expect(result.record.summary).toContain('- Accessible Name: "Save changes"');
    expect(result.record.summary).toContain(
      '- Recommended Locator: page.getByRole("button", { name: "Save changes" })',
    );
    expect(result.record.summary).toContain("- Recommended Locator Strategy: playwright.role");
    expect(result.record.summary).toContain(
      "- Replay: verified by playwright.role page.getByRole(\"button\", { name: \"Save changes\" }), unique",
    );
    expect(result.json).toContain('"allowedDomains": [');
    expect(result.json).toContain('"replayVerified": true');
  });

  test("replay verifies a captured element inside an open shadow root", async () => {
    document.body.innerHTML = '<div id="shadow-host"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) {
      throw new Error("shadow host fixture missing");
    }
    const shadowRoot = host.attachShadow({ mode: "open" });
    const label = document.createElement("span");
    label.id = "shadow-confirm-label";
    label.textContent = "Confirm purchase";
    const button = document.createElement("button");
    button.setAttribute("aria-labelledby", label.id);
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
    shadowRoot.append(label, button);

    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/checkout",
      documentTitle: "Checkout",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      verifiedBy: "playwright.role",
    });
    expect(result.record.attachment.element.accessibleName).toBe("Confirm purchase");
    expect(result.record.replayAttempts?.[0]).toEqual(
      expect.objectContaining({ replayVerified: true, matchCount: 1 }),
    );
  });

  test("captures a dominant cross-origin iframe as an explicit host boundary", async () => {
    document.body.innerHTML = '<iframe title="Documentation" src="https://docs.example.test/reference?token=secret"></iframe>';
    const frame = document.querySelector("iframe");
    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error("iframe fixture missing");
    }
    setVisibleBounds(frame, { x: 0, y: 0, width: 1024, height: 768 });

    const result = await captureElementTarget(frame, {
      locationHref: "https://shell.example.test/docs",
      documentTitle: "Docs shell",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.boundary).toEqual({
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://docs.example.test",
      framePathname: "/reference",
      dominantViewport: true,
    });
    expect(result.record.summary).toContain(
      "- Capture Boundary: embedded frame host; inner DOM not captured",
    );
    expect(result.record.summary).not.toContain("token=secret");
    expect(result.record.markdown).toContain("### Capture Boundary");
    expect(result.json).not.toContain("token=secret");
  });

  test("resolves relative frame routes from the captured page and strips query and fragment data", async () => {
    document.body.innerHTML = '<iframe src="../widgets/chooser?token=secret#private"></iframe>';
    const frame = document.querySelector("iframe");
    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error("iframe fixture missing");
    }

    const result = await captureElementTarget(frame, {
      locationHref: "https://shell.example.test/docs/reference/page?session=private#section",
      documentTitle: "Docs shell",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.boundary).toMatchObject({
      frameOrigin: "https://shell.example.test",
      framePathname: "/docs/widgets/chooser",
    });
    expect(JSON.stringify(result.record.attachment.boundary)).not.toContain("secret");
    expect(JSON.stringify(result.record.attachment.boundary)).not.toContain("private");
  });

  test("resolves a relative frame source against the document base URI", async () => {
    document.head.innerHTML = '<base href="https://frames.example.test/embed/v2/">';
    document.body.innerHTML = '<iframe src="./start?token=secret#private"></iframe>';
    const frame = document.querySelector("iframe");
    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error("iframe fixture missing");
    }

    const result = await captureElementTarget(frame, {
      locationHref: "https://shell.example.test/docs/reference",
      documentTitle: "Docs shell",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.boundary).toMatchObject({
      frameOrigin: "https://frames.example.test",
      framePathname: "/embed/v2/start",
    });
    expect(JSON.stringify(result.record.attachment.boundary)).not.toContain("secret");
    expect(JSON.stringify(result.record.attachment.boundary)).not.toContain("private");
  });

  test("classifies same-origin and opaque iframe hosts without claiming viewport dominance", async () => {
    document.body.innerHTML = `
      <iframe id="same" src="/widget"></iframe>
      <iframe id="opaque" sandbox src="/private"></iframe>
    `;
    const sameOrigin = document.querySelector("#same");
    const opaque = document.querySelector("#opaque");
    if (!(sameOrigin instanceof HTMLIFrameElement) || !(opaque instanceof HTMLIFrameElement)) {
      throw new Error("iframe fixtures missing");
    }
    setVisibleBounds(sameOrigin, { x: 20, y: 20, width: 320, height: 200 });
    setVisibleBounds(opaque, { x: 360, y: 20, width: 320, height: 200 });

    const sameResult = await captureElementTarget(sameOrigin, {
      locationHref: "https://shell.example.test/docs",
      documentTitle: "Docs shell",
    });
    const opaqueResult = await captureElementTarget(opaque, {
      locationHref: "https://shell.example.test/docs",
      documentTitle: "Docs shell",
    });

    expect(sameResult.ok).toBe(true);
    expect(opaqueResult.ok).toBe(true);
    if (!sameResult.ok || !opaqueResult.ok) return;
    expect(sameResult.record.attachment.boundary).toMatchObject({
      originRelation: "same_origin",
      frameOrigin: "https://shell.example.test",
      framePathname: "/widget",
      dominantViewport: false,
    });
    expect(opaqueResult.record.attachment.boundary).toMatchObject({
      originRelation: "opaque_or_unavailable",
      frameOrigin: null,
      framePathname: null,
      dominantViewport: false,
    });
    expect(JSON.stringify(opaqueResult.record)).not.toContain("private");
  });

  test("replay verifies password inputs by label instead of a textbox role", async () => {
    document.body.innerHTML = `
      <label for="password">Password</label>
      <input id="password" type="password">
    `;
    const input = document.querySelector("#password");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("password input fixture missing");
    }
    setVisibleBounds(input, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(input, {
      locationHref: "https://app.example.com/login",
      documentTitle: "Login",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.element.role).toBeNull();
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      verifiedBy: "playwright.label",
    });
    expect(result.record.replayAttempts?.[0]).toEqual(
      expect.objectContaining({ strategy: "playwright.label", matchCount: 1, visible: true }),
    );
  });

  test("replay verifies search inputs with the native searchbox role", async () => {
    document.body.innerHTML = '<input type="search" aria-label="Quick search">';
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("search input fixture missing");
    }
    setVisibleBounds(input, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(input, {
      locationHref: "https://app.example.com/docs",
      documentTitle: "Docs",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.element.role).toBe("searchbox");
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      verifiedBy: "playwright.role",
      verifiedValue: 'page.getByRole("searchbox", { name: "Quick search" })',
    });
  });

  test("replay does not verify a control hidden by ancestor opacity", async () => {
    document.body.innerHTML = '<div style="opacity: 0"><button>Hidden action</button></div>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("hidden button fixture missing");
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

    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/settings",
      documentTitle: "Settings",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.element.visible).toBe(false);
    expect(result.record.attachment.locatorBundle.stability.replayVerified).toBe(false);
    expect(result.record.replayAttempts?.[0]).toEqual(
      expect.objectContaining({ replayVerified: false, matchCount: 0, visible: null }),
    );
  });

  test("replay ignores hidden role duplicates when the selected control is uniquely visible", async () => {
    document.body.innerHTML = `
      <button hidden>Save changes</button>
      <button id="visible-save">Save changes</button>
    `;
    const button = document.querySelector("#visible-save");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("visible save fixture missing");
    }
    setVisibleBounds(button, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/settings",
      documentTitle: "Settings",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      verifiedBy: "playwright.role",
    });
    expect(result.record.replayAttempts?.[0]).toEqual(
      expect.objectContaining({ matchCount: 1, visible: true }),
    );
  });

  test("replay uses input button values as accessible names", async () => {
    document.body.innerHTML = '<input type="submit" value="Save changes">';
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("input button fixture missing");
    }
    setVisibleBounds(input, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(input, {
      locationHref: "https://app.example.com/settings",
      documentTitle: "Settings",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.element.accessibleName).toBe("Save changes");
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      verifiedBy: "playwright.role",
    });
    expect(result.record.replayAttempts?.[0]).toEqual(
      expect.objectContaining({ matchCount: 1, visible: true }),
    );
  });

  test("independently verifies a stable id when dynamic role text is primary", async () => {
    document.body.innerHTML = '<button id="like-button">Likes 10</button>';
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("like button fixture missing");
    }
    setVisibleBounds(button, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/feed",
      documentTitle: "Feed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      verifiedBy: "playwright.role",
    });
    expect(result.record.replayAttempts).toContainEqual(expect.objectContaining({
      strategy: "css",
      value: "#like-button",
      replayVerified: true,
      uniqueness: true,
      matchCount: 1,
      visible: true,
    }));
  });

  test("independently verifies a unique stable data attribute for dynamic text", async () => {
    document.body.innerHTML = '<strong data-tibo-time-clock>07:13:13</strong>';
    const clock = document.querySelector("strong");
    if (!(clock instanceof HTMLElement)) {
      throw new Error("clock fixture missing");
    }
    setVisibleBounds(clock, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(clock, {
      locationHref: "https://app.example.com/feed",
      documentTitle: "Feed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.attachment.locatorBundle.primary).toMatchObject({
      strategy: "playwright.text",
      value: 'page.getByText("07:13:13")',
    });
    expect(result.record.replayAttempts).toContainEqual(expect.objectContaining({
      strategy: "css",
      value: "[data-tibo-time-clock]",
      replayVerified: true,
      uniqueness: true,
      matchCount: 1,
      visible: true,
    }));
  });

  test("independently verifies a repeated dynamic action inside a stable content anchor", async () => {
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
      throw new Error("first like fixture missing");
    }
    setVisibleBounds(target, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(target, {
      locationHref: "https://app.example.com/alice",
      documentTitle: "Profile",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.replayAttempts).toContainEqual(expect.objectContaining({
      strategy: "css",
      value: expect.stringContaining(
        'article:has(a[href="/alice/status/1952521961831320123"])',
      ),
      replayVerified: true,
      uniqueness: true,
      matchCount: 1,
      visible: true,
    }));
  });

  test("preserves sensitive capture details when full debug disclosure is requested", async () => {
    document.body.innerHTML = `
      <section>
        <button data-testid="invite">Invite</button>
        <p>Contact ada@example.com with token sk-test-1234567890</p>
      </section>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("fixture button missing");
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
    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/team?token=secret#members",
      documentTitle: "Team",
      disclosureMode: "full_debug",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.record.pageUrl).toBe("https://app.example.com/team?token=secret#members");
    expect(result.record.attachment.context.nearbyText).toContain(
      "Contact ada@example.com with token sk-test-1234567890",
    );
    expect(result.record.attachment.policy).toMatchObject({
      disclosureMode: "full_debug",
      redactionLevel: "debug",
      allowNetworkSend: false,
      includedSensitiveFields: ["context.nearbyText", "source.url"],
      sensitiveHints: ["context.nearbyText", "source.url"],
    });
    expect(result.record.markdown).toContain("- Disclosure Mode: full_debug");
    expect(result.record.summary).toContain(
      "- Included Sensitive Fields: context.nearbyText, source.url",
    );
  });

  test("keeps the complete direct capture record agent-safe", async () => {
    document.body.innerHTML = `
      <section>
        <button data-testid="sk-test-1234567890" aria-label="Invite ada@example.com">Invite</button>
        <p>Owner ada@example.com</p>
      </section>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("fixture button missing");
    }
    setVisibleBounds(button, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/team?token=secret#members",
      documentTitle: "Team ada@example.com",
      disclosureMode: "agent_safe",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.record.pageUrl).toBe("https://app.example.com/team");
    expect(result.record.pageTitle).toBe("Team [redacted:email]");
    expect(JSON.stringify(result.record)).not.toContain("ada@example.com");
    expect(JSON.stringify(result.record)).not.toContain("sk-test-1234567890");
    expect(result.json).not.toContain("ada@example.com");
    expect(result.json).not.toContain("sk-test-1234567890");
    expect(result.record.replayAttempts?.find(
      (attempt) => attempt.strategy === "playwright.testId",
    )).toMatchObject({ replayVerified: false, matchCount: 0 });
  });

  test("keeps diagnostic URLs while redacting page-controlled text", async () => {
    document.body.innerHTML = `
      <section>
        <button data-testid="sk-test-1234567890" aria-label="Invite ada@example.com">Invite</button>
        <p>Owner ada@example.com</p>
      </section>
    `;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("fixture button missing");
    }
    setVisibleBounds(button, { x: 4, y: 8, width: 120, height: 36 });

    const result = await captureElementTarget(button, {
      locationHref: "https://app.example.com/team?token=secret#members",
      documentTitle: "Team ada@example.com",
      disclosureMode: "developer_diagnostic",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.record.pageUrl).toBe(
      "https://app.example.com/team?token=secret#members",
    );
    expect(result.record.attachment.policy.disclosureMode).toBe("developer_diagnostic");
    expect(result.record.pageTitle).toBe("Team [redacted:email]");
    expect(JSON.stringify(result.record)).not.toContain("ada@example.com");
    expect(JSON.stringify(result.record)).not.toContain("sk-test-1234567890");
    expect(result.record.attachment.artifacts).toEqual({
      screenshotCrop: null,
      overlayImage: null,
    });
  });

  test("captures compatibility fixture sensitive context according to disclosure mode", async () => {
    await loadCompatibilityFixture();
    const button = document.querySelector("[data-testid='rotate-demo-secret']");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("fixture button missing");
    }
    setVisibleBounds(button, { x: 365, y: 535, width: 179, height: 38 });

    const agentSafe = await captureElementTarget(button, {
      locationHref: "http://127.0.0.1:5174/compatibility-fixtures.html?token=compat-secret#fixtures",
      documentTitle: "Compatibility fixtures",
      disclosureMode: "agent_safe",
    });
    const fullDebug = await captureElementTarget(button, {
      locationHref: "http://127.0.0.1:5174/compatibility-fixtures.html?token=compat-secret#fixtures",
      documentTitle: "Compatibility fixtures",
      disclosureMode: "full_debug",
    });

    expect(agentSafe.ok).toBe(true);
    expect(fullDebug.ok).toBe(true);
    if (!agentSafe.ok || !fullDebug.ok) {
      return;
    }

    expect(agentSafe.record.attachment.source.url).toBe(
      "http://127.0.0.1:5174/compatibility-fixtures.html",
    );
    expect(agentSafe.record.attachment.context.nearbyText).toContain(
      "Owner email: [redacted:email]",
    );
    expect(agentSafe.record.attachment.context.nearbyText).toContain(
      "API token: [redacted:secret]",
    );
    expect(agentSafe.record.attachment.policy).toMatchObject({
      disclosureMode: "agent_safe",
      redactionLevel: "strict",
      redactedFields: ["context.nearbyText", "source.url"],
      sensitiveHints: ["context.nearbyText", "source.url"],
      includedSensitiveFields: [],
    });

    expect(fullDebug.record.attachment.source.url).toBe(
      "http://127.0.0.1:5174/compatibility-fixtures.html?token=compat-secret#fixtures",
    );
    expect(fullDebug.record.attachment.context.nearbyText).toContain(
      "Owner email: ada@example.com",
    );
    expect(fullDebug.record.attachment.context.nearbyText).toContain(
      "API token: sk-test-1234567890",
    );
    expect(fullDebug.record.attachment.policy).toMatchObject({
      disclosureMode: "full_debug",
      redactionLevel: "debug",
      redactedFields: [],
      sensitiveHints: ["context.nearbyText", "source.url"],
      includedSensitiveFields: ["context.nearbyText", "source.url"],
    });
    expect(fullDebug.record.attachment.locatorBundle.stability).toMatchObject({
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
    });
  });
});

async function loadCompatibilityFixture(): Promise<void> {
  const html = await readFile(compatibilityFixturePath, "utf8");
  const fixture = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = fixture.body.innerHTML;
}

function setVisibleBounds(
  element: HTMLElement,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      ...bounds,
      top: bounds.y,
      left: bounds.x,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
      toJSON: () => ({}),
    }) as DOMRect;
}
