// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import { CAPTURE_COMPARISON_FIELDS, type CaptureObservation } from "./capture-comparison";
import { createBrowserCaptureObservationReader } from "./browser-capture-observation";
import type { ActivePageContext, CaptureObservationResponse } from "./messages";

const ORIGIN = "https://app.example.test";
const PATHNAME = "/settings";
const DOCUMENT_ID = "document-a";

const observation: CaptureObservation = {
  capturedAt: "2026-09-05T00:00:00.000Z",
  fields: {},
  unavailableFields: [...CAPTURE_COMPARISON_FIELDS],
};

describe("createBrowserCaptureObservationReader", () => {
  test("reads an observation from the exact frame document and route", async () => {
    const browser = createBrowserMock([
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
    ]);
    browser.tabs.sendMessage.mockResolvedValue(observedResponse());
    const reader = createBrowserCaptureObservationReader(browser.value);

    await expect(reader(page(), "item-a", "attachment-a")).resolves.toEqual({
      status: "observed",
      observation,
    });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      {
        type: "ui-attach:capture-observation-get",
        origin: ORIGIN,
        pathname: PATHNAME,
        itemId: "item-a",
        attachmentId: "attachment-a",
      },
      { frameId: 2, documentId: DOCUMENT_ID },
    );
    expect(browser.webNavigation.getFrame).toHaveBeenNthCalledWith(1, { tabId: 7, frameId: 2 });
    expect(browser.webNavigation.getFrame).toHaveBeenNthCalledWith(2, { tabId: 7, frameId: 2 });
  });

  test("rejects an active page document mismatch before sending", async () => {
    const browser = createBrowserMock([frame("document-b", `${ORIGIN}${PATHNAME}`)]);
    const reader = createBrowserCaptureObservationReader(browser.value);

    await expect(reader(page(), "item-a", "attachment-a")).resolves.toBeNull();
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test.each([
    ["document", frame("document-b", `${ORIGIN}${PATHNAME}`)],
    ["route", frame(DOCUMENT_ID, `${ORIGIN}/other`)],
    ["origin", frame(DOCUMENT_ID, `https://other.example.test${PATHNAME}`)],
  ])("rejects a changed %s after the message", async (_label, afterFrame) => {
    const browser = createBrowserMock([
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
      afterFrame,
    ]);
    browser.tabs.sendMessage.mockResolvedValue(observedResponse());
    const reader = createBrowserCaptureObservationReader(browser.value);

    await expect(reader(page(), "item-a", "attachment-a")).resolves.toBeNull();
  });

  test.each([
    ["item", { itemId: "other-item" }],
    ["attachment", { attachmentId: "other-attachment" }],
    ["origin", { origin: "https://other.example.test" }],
    ["pathname", { pathname: "/other" }],
  ])("rejects a response with a mismatched %s scope", async (_label, override) => {
    const browser = createBrowserMock([
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
    ]);
    browser.tabs.sendMessage.mockResolvedValue(observedResponse(override));
    const reader = createBrowserCaptureObservationReader(browser.value);

    await expect(reader(page(), "item-a", "attachment-a")).resolves.toBeNull();
  });

  test("returns null rather than throwing for transport or invalid responses", async () => {
    const browser = createBrowserMock([
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
      frame(DOCUMENT_ID, `${ORIGIN}${PATHNAME}`),
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error("document went away"));
    const reader = createBrowserCaptureObservationReader(browser.value);

    await expect(reader(page(), "item-a", "attachment-a")).resolves.toBeNull();

    browser.tabs.sendMessage.mockResolvedValue({ ok: true, data: null });
    await expect(reader(page(), "item-a", "attachment-a")).resolves.toBeNull();
  });
});

function page(overrides: Partial<ActivePageContext> = {}): ActivePageContext {
  return {
    tabId: 7,
    frameId: 2,
    origin: ORIGIN,
    pathname: PATHNAME,
    documentId: DOCUMENT_ID,
    ...overrides,
  };
}

function frame(documentId: string, url: string): { documentId: string; url: string } {
  return { documentId, url };
}

function observedResponse(
  overrides: Partial<CaptureObservationResponse["data"]> = {},
): CaptureObservationResponse {
  return {
    ok: true,
    data: {
      itemId: "item-a",
      attachmentId: "attachment-a",
      origin: ORIGIN,
      pathname: PATHNAME,
      status: "observed",
      observation,
      ...overrides,
    },
  };
}

function createBrowserMock(frames: Array<{ documentId: string; url: string }>) {
  const getFrame = vi.fn(async () => frames.shift() ?? null);
  const sendMessage = vi.fn();
  const value = {
    webNavigation: { getFrame },
    tabs: { sendMessage },
  } as unknown as Pick<typeof chrome, "webNavigation" | "tabs">;
  return {
    value,
    webNavigation: { getFrame },
    tabs: { sendMessage },
  };
}
