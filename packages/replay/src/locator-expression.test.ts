import { UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS } from "@meanthis/schema";
import { describe, expect, it } from "vitest";
import { resolveReplayLocatorExpression } from "./locator-expression";
import type {
  ReplayLocatorLike,
  ReplayPageLike,
  ReplayQueryScopeLike,
} from "./types";

function terminalLocator(): ReplayLocatorLike {
  return {
    count: async () => 1,
    isVisible: async () => true,
  };
}

describe("resolveReplayLocatorExpression", () => {
  it("resolves a frame-scoped role chain in order with receiver binding", () => {
    const calls: unknown[] = [];
    const resultLocator = terminalLocator();
    const frameScope: ReplayQueryScopeLike = {
      getByRole(this: ReplayQueryScopeLike, role, options) {
        expect(this).toBe(frameScope);
        calls.push(["frame.getByRole", role, options]);
        return resultLocator;
      },
    };
    const page: ReplayPageLike = {
      frameLocator(this: ReplayQueryScopeLike, selector) {
        expect(this).toBe(page);
        calls.push(["page.frameLocator", selector]);
        return frameScope;
      },
    };

    expect(
      resolveReplayLocatorExpression(
        page,
        "playwright.role",
        'page.frameLocator("iframe[title=\\"Compatibility iframe\\"]").getByRole("button", { name: "Submit iframe form" })',
      ),
    ).toEqual({ locator: resultLocator, failureReason: null });
    expect(calls).toEqual([
      ["page.frameLocator", 'iframe[title="Compatibility iframe"]'],
      ["frame.getByRole", "button", { name: "Submit iframe form" }],
    ]);
  });

  it("resolves a locator-scoped role chain in order with receiver binding", () => {
    const calls: unknown[] = [];
    const resultLocator = terminalLocator();
    const dialogLocator: ReplayLocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      getByRole(this: ReplayQueryScopeLike, role, options) {
        expect(this).toBe(dialogLocator);
        calls.push(["dialog.getByRole", role, options]);
        return resultLocator;
      },
    };
    const page: ReplayPageLike = {
      getByRole(this: ReplayQueryScopeLike, role, options) {
        expect(this).toBe(page);
        calls.push(["page.getByRole", role, options]);
        return dialogLocator;
      },
    };

    expect(
      resolveReplayLocatorExpression(
        page,
        "playwright.role",
        'page.getByRole("dialog", { name: "Plan change dialog" }).getByRole("button", { name: "Confirm plan change" })',
      ),
    ).toEqual({ locator: resultLocator, failureReason: null });
    expect(calls).toEqual([
      ["page.getByRole", "dialog", { name: "Plan change dialog" }],
      ["dialog.getByRole", "button", { name: "Confirm plan change" }],
    ]);
  });

  it("rejects raw control characters in static strings", () => {
    let called = false;
    const page: ReplayPageLike = {
      getByText() {
        called = true;
        return terminalLocator();
      },
    };

    expect(
      resolveReplayLocatorExpression(page, "playwright.text", 'page.getByText("Save\tNow")'),
    ).toEqual({ locator: null, failureReason: "could not parse locator expression" });
    expect(called).toBe(false);
  });

  it("rejects a final method that does not match the declared strategy before adapter calls", () => {
    let calls = 0;
    const page: ReplayPageLike = {
      getByText() {
        calls += 1;
        return terminalLocator();
      },
    };

    expect(
      resolveReplayLocatorExpression(
        page,
        "playwright.role",
        'page.getByText("Save changes")',
      ),
    ).toEqual({ locator: null, failureReason: "could not parse locator expression" });
    expect(calls).toBe(0);
  });

  it("accepts only matching quote and backslash escapes", () => {
    const values: string[] = [];
    const page: ReplayPageLike = {
      getByText(text) {
        values.push(text);
        return terminalLocator();
      },
    };

    expect(
      resolveReplayLocatorExpression(
        page,
        "playwright.text",
        String.raw`page.getByText('C:\\Temp\'s')`,
      ),
    ).toMatchObject({ failureReason: null });
    expect(values).toEqual([String.raw`C:\Temp's`]);

    for (const value of [
      String.raw`page.getByText("Save\n")`,
      "page.getByText(\"Save\\\nNow\")",
      `page.getByText("Save${String.fromCharCode(0x85)}Now")`,
    ]) {
      expect(resolveReplayLocatorExpression(page, "playwright.text", value)).toEqual({
        locator: null,
        failureReason: "could not parse locator expression",
      });
    }
    expect(values).toHaveLength(1);
  });

  it("enforces exact chain-step and expression-length bounds", () => {
    let calls = 0;
    const chainedLocator: ReplayLocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      getByRole() {
        calls += 1;
        return chainedLocator;
      },
    };
    const page: ReplayPageLike = {
      getByRole() {
        calls += 1;
        return chainedLocator;
      },
      getByText() {
        calls += 1;
        return terminalLocator();
      },
    };
    const roleStep = 'getByRole("button")';
    const eightSteps = `page.${Array.from({ length: 8 }, () => roleStep).join(".")}`;
    const nineSteps = `page.${Array.from({ length: 9 }, () => roleStep).join(".")}`;

    expect(
      resolveReplayLocatorExpression(page, "playwright.role", eightSteps),
    ).toMatchObject({ failureReason: null });
    expect(calls).toBe(8);
    expect(resolveReplayLocatorExpression(page, "playwright.role", nineSteps)).toEqual({
      locator: null,
      failureReason: "could not parse locator expression",
    });
    expect(calls).toBe(8);

    const prefix = 'page.getByText("';
    const suffix = '")';
    const atLimit = `${prefix}${"x".repeat(
      UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS - prefix.length - suffix.length,
    )}${suffix}`;
    expect(atLimit).toHaveLength(UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS);
    expect(
      resolveReplayLocatorExpression(page, "playwright.text", atLimit),
    ).toMatchObject({ failureReason: null });
    expect(calls).toBe(9);
    expect(resolveReplayLocatorExpression(page, "playwright.text", `${atLimit}x`)).toEqual({
      locator: null,
      failureReason: "could not parse locator expression",
    });
    expect(calls).toBe(9);
  });
});
