import { describe, expect, test } from "vitest";
import { getCaptureStorageKey } from "./capture-store";
import { createOriginScope } from "./origin";

describe("createOriginScope", () => {
  test("uses a strict origin key and redacts query strings and hashes", () => {
    const scope = createOriginScope("http://127.0.0.1:5174/account?token=secret#billing");

    expect(scope.origin).toBe("http://127.0.0.1:5174");
    expect(scope.redactedUrl).toBe("http://127.0.0.1:5174/account");
    expect(scope.redactedFields).toEqual(["source.url"]);
    expect(getCaptureStorageKey(scope.origin)).toBe(
      "ui-attach:capture:http://127.0.0.1:5174",
    );
  });

  test("keeps sibling subdomains in separate origin buckets", () => {
    const app = createOriginScope("https://app.example.com/settings");
    const admin = createOriginScope("https://admin.example.com/settings");

    expect(app.origin).toBe("https://app.example.com");
    expect(admin.origin).toBe("https://admin.example.com");
    expect(getCaptureStorageKey(app.origin)).not.toBe(getCaptureStorageKey(admin.origin));
  });

  test("rejects unsupported browser URLs", () => {
    expect(() => createOriginScope("chrome://extensions")).toThrow(
      "ui-attach extension capture only supports http(s) pages",
    );
  });
});
