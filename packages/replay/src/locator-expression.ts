import {
  UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS,
  type UILocatorStrategy,
} from "@meanthis/schema";
import type { ReplayLocatorLike, ReplayQueryScopeLike } from "./types.js";

const MAX_STEPS = 8;
const PARSE_FAILURE = "could not parse locator expression";
const METHOD_UNAVAILABLE = "locator method is not available";

type StringMethodName =
  | "getByLabel"
  | "getByTestId"
  | "getByText"
  | "getByAltText"
  | "getByTitle"
  | "getByPlaceholder";

type LocatorStep =
  | { method: "frameLocator" | "locator"; value: string }
  | { method: "getByRole"; role: string; name?: string }
  | { method: StringMethodName; value: string };

type FinalMethodName = "getByRole" | StringMethodName;

export type ReplayExpressionResolution =
  | { locator: ReplayLocatorLike; failureReason: null }
  | { locator: null; failureReason: string };

const FINAL_METHOD_BY_STRATEGY = {
  "playwright.role": "getByRole",
  "playwright.label": "getByLabel",
  "playwright.testId": "getByTestId",
  "playwright.text": "getByText",
  "playwright.altText": "getByAltText",
  "playwright.title": "getByTitle",
  "playwright.placeholder": "getByPlaceholder",
} as const;

const METHOD_NAMES = [
  "frameLocator",
  "getByPlaceholder",
  "getByTestId",
  "getByAltText",
  "getByLabel",
  "getByTitle",
  "getByRole",
  "getByText",
  "locator",
] as const;

export function resolveReplayLocatorExpression(
  scope: ReplayQueryScopeLike,
  strategy: UILocatorStrategy,
  value: string,
): ReplayExpressionResolution {
  if (value.length > UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS) {
    return parseFailure();
  }

  const steps = new LocatorExpressionParser(value).parse();
  const finalMethod = finalMethodForStrategy(strategy);
  if (
    steps === null ||
    finalMethod === null ||
    steps[steps.length - 1]?.method === "frameLocator" ||
    steps[steps.length - 1]?.method !== finalMethod
  ) {
    return parseFailure();
  }

  let currentScope = scope;
  for (let index = 0; index < steps.length; index += 1) {
    const result = invokeStep(currentScope, steps[index]);
    if (result === null) {
      return unavailableMethod();
    }

    if (index === steps.length - 1) {
      if (!isReplayLocatorLike(result)) {
        return unavailableMethod();
      }
      return { locator: result, failureReason: null };
    }

    if (!isReplayQueryScopeLike(result)) {
      return unavailableMethod();
    }
    currentScope = result;
  }

  return parseFailure();
}

class LocatorExpressionParser {
  private cursor = 0;

  constructor(private readonly source: string) {}

  parse(): LocatorStep[] | null {
    if (!this.consume("page")) {
      return null;
    }

    const steps: LocatorStep[] = [];
    while (!this.atEnd()) {
      if (steps.length === MAX_STEPS || !this.consume(".")) {
        return null;
      }

      const step = this.parseStep();
      if (step === null) {
        return null;
      }
      steps.push(step);
    }

    return steps.length > 0 ? steps : null;
  }

  private parseStep(): LocatorStep | null {
    const method = this.parseMethodName();
    if (method === null || !this.consume("(")) {
      return null;
    }

    this.skipWhitespace();
    if (method === "getByRole") {
      return this.parseRoleStep();
    }

    const value = this.parseStaticString();
    if (value === null) {
      return null;
    }
    this.skipWhitespace();
    if (!this.consume(")")) {
      return null;
    }
    return { method, value };
  }

  private parseRoleStep(): LocatorStep | null {
    const role = this.parseStaticString();
    if (role === null) {
      return null;
    }

    this.skipWhitespace();
    if (this.consume(")")) {
      return { method: "getByRole", role };
    }
    if (!this.consume(",")) {
      return null;
    }

    this.skipWhitespace();
    const name = this.parseNameOptions();
    if (name === null) {
      return null;
    }
    this.skipWhitespace();
    if (!this.consume(")")) {
      return null;
    }
    return { method: "getByRole", role, name };
  }

  private parseNameOptions(): string | null {
    if (!this.consume("{")) {
      return null;
    }
    this.skipWhitespace();
    if (!this.consume("name")) {
      return null;
    }
    this.skipWhitespace();
    if (!this.consume(":")) {
      return null;
    }
    this.skipWhitespace();

    const name = this.parseStaticString();
    if (name === null) {
      return null;
    }
    this.skipWhitespace();
    return this.consume("}") ? name : null;
  }

  private parseMethodName(): (typeof METHOD_NAMES)[number] | null {
    for (const method of METHOD_NAMES) {
      if (this.source.startsWith(method, this.cursor)) {
        this.cursor += method.length;
        return method;
      }
    }
    return null;
  }

  private parseStaticString(): string | null {
    const quote = this.source[this.cursor];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    this.cursor += 1;

    let result = "";
    while (!this.atEnd()) {
      const character = this.source[this.cursor];
      this.cursor += 1;
      if (character === quote) {
        return result;
      }
      if (character === "\\") {
        if (this.atEnd()) {
          return null;
        }
        const escaped = this.source[this.cursor];
        this.cursor += 1;
        if (escaped !== quote && escaped !== "\\") {
          return null;
        }
        result += escaped;
        continue;
      }
      const codeUnit = character.charCodeAt(0);
      if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
        return null;
      }
      result += character;
    }
    return null;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.cursor] === " " ||
      this.source[this.cursor] === "\t" ||
      this.source[this.cursor] === "\r" ||
      this.source[this.cursor] === "\n"
    ) {
      this.cursor += 1;
    }
  }

  private consume(expected: string): boolean {
    if (!this.source.startsWith(expected, this.cursor)) {
      return false;
    }
    this.cursor += expected.length;
    return true;
  }

  private atEnd(): boolean {
    return this.cursor === this.source.length;
  }
}

function finalMethodForStrategy(strategy: UILocatorStrategy): FinalMethodName | null {
  switch (strategy) {
    case "playwright.role":
      return FINAL_METHOD_BY_STRATEGY["playwright.role"];
    case "playwright.label":
      return FINAL_METHOD_BY_STRATEGY["playwright.label"];
    case "playwright.testId":
      return FINAL_METHOD_BY_STRATEGY["playwright.testId"];
    case "playwright.text":
      return FINAL_METHOD_BY_STRATEGY["playwright.text"];
    case "playwright.altText":
      return FINAL_METHOD_BY_STRATEGY["playwright.altText"];
    case "playwright.title":
      return FINAL_METHOD_BY_STRATEGY["playwright.title"];
    case "playwright.placeholder":
      return FINAL_METHOD_BY_STRATEGY["playwright.placeholder"];
    case "css":
    case "xpath":
    case "coordinates":
      return null;
  }
}

function invokeStep(
  scope: ReplayQueryScopeLike,
  step: LocatorStep,
): ReplayQueryScopeLike | ReplayLocatorLike | null {
  switch (step.method) {
    case "frameLocator": {
      const method = scope.frameLocator;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "locator": {
      const method = scope.locator;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "getByRole": {
      const method = scope.getByRole;
      if (typeof method !== "function") {
        return null;
      }
      return step.name === undefined
        ? method.call(scope, step.role)
        : method.call(scope, step.role, { name: step.name });
    }
    case "getByLabel": {
      const method = scope.getByLabel;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "getByTestId": {
      const method = scope.getByTestId;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "getByText": {
      const method = scope.getByText;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "getByAltText": {
      const method = scope.getByAltText;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "getByTitle": {
      const method = scope.getByTitle;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
    case "getByPlaceholder": {
      const method = scope.getByPlaceholder;
      return typeof method === "function" ? method.call(scope, step.value) : null;
    }
  }
}

function isReplayQueryScopeLike(value: unknown): value is ReplayQueryScopeLike {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const scope = value as ReplayQueryScopeLike;
  return (
    typeof scope.frameLocator === "function" ||
    typeof scope.locator === "function" ||
    typeof scope.getByRole === "function" ||
    typeof scope.getByLabel === "function" ||
    typeof scope.getByTestId === "function" ||
    typeof scope.getByText === "function" ||
    typeof scope.getByAltText === "function" ||
    typeof scope.getByTitle === "function" ||
    typeof scope.getByPlaceholder === "function"
  );
}

function isReplayLocatorLike(value: unknown): value is ReplayLocatorLike {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const locator = value as Partial<ReplayLocatorLike>;
  return typeof locator.count === "function" && typeof locator.isVisible === "function";
}

function parseFailure(): ReplayExpressionResolution {
  return { locator: null, failureReason: PARSE_FAILURE };
}

function unavailableMethod(): ReplayExpressionResolution {
  return { locator: null, failureReason: METHOD_UNAVAILABLE };
}
