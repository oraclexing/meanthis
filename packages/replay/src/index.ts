import type { UIAttachment, UIAttachmentLocator, UILocatorStrategy } from "@meanthis/schema";
import { resolveReplayLocatorExpression } from "./locator-expression.js";
import type { ReplayLocatorLike, ReplayPageLike } from "./types.js";

export type { ReplayLocatorLike, ReplayPageLike, ReplayQueryScopeLike } from "./types.js";

export interface LocatorReplayAttempt {
  strategy: UILocatorStrategy;
  value: string;
  replayVerified: boolean;
  uniqueness: boolean | null;
  failureReason: string | null;
  matchCount: number | null;
  visible: boolean | null;
}

export interface LocatorReplayResult {
  replayVerified: boolean;
  uniqueness: boolean | null;
  matchedBy: UILocatorStrategy | null;
  matchedValue: string | null;
  failureReason: string | null;
  matchCount: number | null;
  visible: boolean | null;
  attempts: LocatorReplayAttempt[];
}

export type ReplayLocatorResolution = {
  locator: null;
  failureReason: string;
} | {
  locator: ReplayLocatorLike;
  failureReason: null;
};

export async function verifyAttachmentLocator(
  page: ReplayPageLike,
  attachment: UIAttachment,
): Promise<LocatorReplayResult> {
  const primary = attachment.locatorBundle.primary;
  const locators = buildLocatorAttempts(primary, attachment.locatorBundle.candidates);
  if (locators.length === 0) {
    return failure(null, "no primary locator", []);
  }

  const attempts: LocatorReplayAttempt[] = [];
  for (const locator of locators) {
    const attempt = await verifySingleLocator(page, locator);
    attempts.push(attempt);
    if (attempt.replayVerified) {
      return attemptToResult(attempt, attempts);
    }
  }

  const actionableFailure = [...attempts]
    .reverse()
    .find((attempt) => attempt.strategy !== "coordinates");
  return attemptToResult(actionableFailure ?? attempts[attempts.length - 1], attempts);
}

export function applyReplayResult(
  attachment: UIAttachment,
  result: LocatorReplayResult,
): UIAttachment {
  const verifiedPrimary =
    result.replayVerified && result.matchedBy && result.matchedValue
      ? [
          ...(attachment.locatorBundle.primary ? [attachment.locatorBundle.primary] : []),
          ...attachment.locatorBundle.candidates,
        ].find(
          (locator) =>
            locator.strategy === result.matchedBy && locator.value === result.matchedValue,
        ) ?? attachment.locatorBundle.primary
      : attachment.locatorBundle.primary;
  const primaryChanged =
    verifiedPrimary !== null &&
    (attachment.locatorBundle.primary === null ||
      verifiedPrimary.strategy !== attachment.locatorBundle.primary.strategy ||
      verifiedPrimary.value !== attachment.locatorBundle.primary.value);
  const stabilityScore = primaryChanged
    ? scoreLocatorStability(verifiedPrimary, attachment.locatorBundle.candidates)
    : attachment.locatorBundle.stability.score;

  return {
    ...attachment,
    locatorBundle: {
      ...attachment.locatorBundle,
      primary: verifiedPrimary,
      stability: {
        ...attachment.locatorBundle.stability,
        score: stabilityScore,
        uniqueness: result.uniqueness,
        replayVerified: result.replayVerified,
        failureReason: result.failureReason,
        verifiedBy: result.replayVerified ? result.matchedBy : null,
        verifiedValue: result.replayVerified ? result.matchedValue : null,
      },
    },
  };
}

function scoreLocatorStability(
  primary: UIAttachmentLocator,
  candidates: UIAttachmentLocator[],
): number {
  const scoredPrimary =
    primary.notes === "structural fallback"
      ? candidates.find((candidate) => candidate.notes !== "structural fallback") ?? null
      : primary;
  if (!scoredPrimary) {
    return 0;
  }

  const primaryScore = Math.round(scoredPrimary.confidence * 70);
  const scoredCandidateCount = candidates.filter(
    (candidate) => candidate.notes !== "structural fallback",
  ).length;
  const fallbackScore = Math.min(Math.max(scoredCandidateCount - 1, 0), 3) * 4;
  return Math.min(100, primaryScore + fallbackScore);
}

async function verifySingleLocator(
  page: ReplayPageLike,
  locator: UIAttachmentLocator,
): Promise<LocatorReplayAttempt> {
  let resolution: ReplayLocatorResolution;
  try {
    resolution = resolveReplayLocator(page, locator.strategy, locator.value);
  } catch (error) {
    return attemptFailure(
      locator,
      null,
      null,
      "locator replay adapter failed",
    );
  }
  if (resolution.locator === null) {
    return attemptFailure(locator, null, null, resolution.failureReason);
  }

  try {
    const matchCount = await resolution.locator.count();
    if (matchCount !== 1) {
      return attemptFailure(locator, false, matchCount, `locator matched ${matchCount} elements`);
    }

    const visible = await resolution.locator.isVisible();
    if (!visible) {
      return {
        strategy: locator.strategy,
        value: locator.value,
        replayVerified: false,
        uniqueness: true,
        failureReason: "locator matched one element but it was not visible",
        matchCount,
        visible,
      };
    }

    return {
      strategy: locator.strategy,
      value: locator.value,
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount,
      visible,
    };
  } catch (error) {
    return attemptFailure(
      locator,
      null,
      null,
      "locator replay adapter failed",
    );
  }
}

function buildLocatorAttempts(
  primary: UIAttachmentLocator | null,
  candidates: UIAttachmentLocator[],
): UIAttachmentLocator[] {
  const seen = new Set<string>();
  return [...(primary ? [primary] : []), ...candidates].filter((locator) => {
    const key = `${locator.strategy}:${locator.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function attemptToResult(
  attempt: LocatorReplayAttempt,
  attempts: LocatorReplayAttempt[],
): LocatorReplayResult {
  return {
    replayVerified: attempt.replayVerified,
    uniqueness: attempt.uniqueness,
    matchedBy: attempt.replayVerified ? attempt.strategy : null,
    matchedValue: attempt.replayVerified ? attempt.value : null,
    failureReason: attempt.failureReason,
    matchCount: attempt.matchCount,
    visible: attempt.visible,
    attempts,
  };
}

function attemptFailure(
  locator: UIAttachmentLocator,
  uniqueness: boolean | null,
  matchCount: number | null,
  failureReason: string,
): LocatorReplayAttempt {
  return {
    strategy: locator.strategy,
    value: locator.value,
    replayVerified: false,
    uniqueness,
    failureReason,
    matchCount,
    visible: null,
  };
}

export function resolveReplayLocator(
  page: ReplayPageLike,
  strategy: UILocatorStrategy,
  value: string,
): ReplayLocatorResolution {
  switch (strategy) {
    case "playwright.role":
    case "playwright.label":
    case "playwright.testId":
    case "playwright.text":
    case "playwright.altText":
    case "playwright.title":
    case "playwright.placeholder":
      return resolveReplayLocatorExpression(page, strategy, value);
    case "css":
    case "xpath":
      if (!page.locator) {
        return { locator: null, failureReason: "page.locator is not available" };
      }
      return { locator: page.locator(value), failureReason: null };
    case "coordinates":
      return {
        locator: null,
        failureReason: "coordinates locators cannot be replay verified",
      };
  }
}

function failure(
  matchedBy: UILocatorStrategy | null,
  failureReason: string,
  attempts: LocatorReplayAttempt[],
): LocatorReplayResult {
  return {
    replayVerified: false,
    uniqueness: null,
    matchedBy,
    matchedValue: null,
    failureReason,
    matchCount: null,
    visible: null,
    attempts,
  };
}
