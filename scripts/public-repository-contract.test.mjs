import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("public repository contract", () => {
  test("keeps the projected repository product-first and public-safe", async () => {
    const [english, chinese, privacy, privacyChinese, releasing, releasingChinese, config] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "README_zh.md"), "utf8"),
      readFile(join(root, "PRIVACY.md"), "utf8"),
      readFile(join(root, "PRIVACY_zh.md"), "utf8"),
      readFile(join(root, "RELEASING.md"), "utf8"),
      readFile(join(root, "RELEASING_zh.md"), "utf8"),
      readFile(join(root, "_config.yml"), "utf8"),
    ]);
    for (const heading of [
      "## Why MeanThis",
      "## Three-step workflow",
      "## What the Agent receives",
      "## Privacy and security",
    ]) expect(english).toContain(heading);
    for (const heading of [
      "## 为什么使用 MeanThis",
      "## 三步工作流",
      "## Agent 会收到什么",
      "## 隐私与安全",
    ]) expect(chinese).toContain(heading);
    expect(privacy).toContain("permalink: /privacy/");
    expect(privacyChinese).toContain("permalink: /zh/privacy/");
    expect(privacy).toContain("Chrome Web Store User Data Policy");
    expect(privacyChinese).toContain("Chrome Web Store User Data Policy");
    expect(releasing).toContain("normal incremental commits and pull requests");
    expect(releasingChinese).toContain("正常的增量 commit 与 pull request");
    expect(config).toContain('baseurl: "/meanthis"');
    for (const excluded of ["apps", "packages", "scripts", "tools"]) {
      expect(config).toContain(`  - ${excluded}`);
    }

    for (const path of [
      "apps/extension-mv3/store",
      "benchmarks",
      "docs/dogfood",
      "docs/plans",
      "packages/html-ops",
      "tools/upstream-conformance",
      "tools/vite-source-map",
    ]) expect(existsSync(join(root, ...path.split("/"))), path).toBe(false);
  });
});
