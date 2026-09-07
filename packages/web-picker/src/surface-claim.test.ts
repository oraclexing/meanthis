// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_SURFACE_CLAIM_SELECTOR,
  claimMeanThisSurface,
} from "./surface-claim";

describe("claimMeanThisSurface", () => {
  beforeEach(() => {
    document.querySelectorAll(MEANTHIS_SURFACE_CLAIM_SELECTOR).forEach((element) => element.remove());
    document.body.replaceChildren();
  });

  test("creates one non-sensitive SDK claim and handles open requests", () => {
    const onOpenRequest = vi.fn();
    const claim = claimMeanThisSurface({
      root: document,
      owner: "sdk",
      onOpenRequest,
    });

    expect(claim.status).toBe("claimed");
    expect(claim.currentOwner).toBe("sdk");
    expect(document.querySelectorAll(MEANTHIS_SURFACE_CLAIM_SELECTOR)).toHaveLength(1);
    expect(claim.element?.dataset.uiAttachIgnore).toBe("true");
    expect(claim.element?.outerHTML).not.toMatch(/token|capability|invitation|task/i);
    expect(claim.requestOpen()).toBe(true);
    expect(onOpenRequest).toHaveBeenCalledOnce();

    claim.release();
    expect(document.querySelector(MEANTHIS_SURFACE_CLAIM_SELECTOR)).toBeNull();
  });

  test("delegates extension activation to an existing SDK surface", () => {
    const onOpenRequest = vi.fn();
    const sdk = claimMeanThisSurface({ root: document, owner: "sdk", onOpenRequest });
    const extension = claimMeanThisSurface({ root: document, owner: "extension" });

    expect(sdk.status).toBe("claimed");
    expect(extension.status).toBe("delegated");
    expect(extension.currentOwner).toBe("sdk");
    expect(extension.requestOpen()).toBe(true);
    expect(onOpenRequest).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(MEANTHIS_SURFACE_CLAIM_SELECTOR)).toHaveLength(1);
  });

  test("delegates an SDK to an existing extension surface without replacing it", () => {
    const extension = claimMeanThisSurface({ root: document, owner: "extension" });
    const extensionElement = extension.element;
    const sdk = claimMeanThisSurface({ root: document, owner: "sdk" });

    expect(sdk.status).toBe("delegated");
    expect(sdk.currentOwner).toBe("extension");
    expect(sdk.element).toBe(extensionElement);
    sdk.release();
    expect(extensionElement?.isConnected).toBe(true);
  });

  test("treats repeated same-owner initialization as delegated", () => {
    const first = claimMeanThisSurface({ root: document, owner: "sdk" });
    const second = claimMeanThisSurface({ root: document, owner: "sdk" });

    expect(first.status).toBe("claimed");
    expect(second.status).toBe("delegated");
    expect(second.element).toBe(first.element);
  });

  test("fails closed for malformed or duplicate claim markers", () => {
    const malformed = document.createElement("span");
    malformed.dataset.meanthisSurfaceClaim = "1";
    malformed.dataset.meanthisSurfaceOwner = "sdk";
    document.documentElement.append(malformed);

    const malformedClaim = claimMeanThisSurface({ root: document, owner: "extension" });
    expect(malformedClaim.status).toBe("conflict");
    expect(malformedClaim.requestOpen()).toBe(false);

    const duplicate = malformed.cloneNode() as HTMLElement;
    document.documentElement.append(duplicate);
    const duplicateClaim = claimMeanThisSurface({ root: document, owner: "extension" });
    expect(duplicateClaim.status).toBe("conflict");
    expect(document.querySelectorAll(MEANTHIS_SURFACE_CLAIM_SELECTOR)).toHaveLength(2);
  });

  test("never removes a replacement that appears at the claim pathname", () => {
    const claim = claimMeanThisSurface({ root: document, owner: "sdk" });
    const original = claim.element;
    const replacement = original?.cloneNode() as HTMLElement;
    original?.replaceWith(replacement);

    claim.release();
    expect(replacement.isConnected).toBe(true);
    expect(document.querySelector(MEANTHIS_SURFACE_CLAIM_SELECTOR)).toBe(replacement);
  });

  test("notifies the owner when its exact claim is removed", async () => {
    const onClaimLost = vi.fn();
    const claim = claimMeanThisSurface({ root: document, owner: "sdk", onClaimLost });

    claim.element?.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onClaimLost).toHaveBeenCalledOnce();
    expect(claim.requestOpen()).toBe(false);
  });
});
