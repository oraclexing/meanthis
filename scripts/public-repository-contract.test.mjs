import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDocsRoot = existsSync(join(root, "AGENT_INSTALL.md"))
  ? root
  : resolve(root, "..", "..");

describe("public repository contract", () => {
  test("keeps the projected repository product-first and public-safe", async () => {
    const [
      english,
      chinese,
      agentInstall,
      agentInstallChinese,
      privacy,
      privacyChinese,
      releasing,
      releasingChinese,
      config,
      releaseWorkflow,
      rootManifest,
    ] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "README_zh.md"), "utf8"),
      readFile(join(agentDocsRoot, "AGENT_INSTALL.md"), "utf8"),
      readFile(join(agentDocsRoot, "AGENT_INSTALL_zh.md"), "utf8"),
      readFile(join(root, "PRIVACY.md"), "utf8"),
      readFile(join(root, "PRIVACY_zh.md"), "utf8"),
      readFile(join(root, "RELEASING.md"), "utf8"),
      readFile(join(root, "RELEASING_zh.md"), "utf8"),
      readFile(join(root, "_config.yml"), "utf8"),
      readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
      readFile(join(agentDocsRoot, "package.json"), "utf8").then(JSON.parse),
    ]);
    for (const heading of [
      "## Why MeanThis",
      "## Three-step workflow",
      "## What the Agent receives",
      "## Install with an Agent",
      "## Privacy and security",
    ]) expect(english).toContain(heading);
    for (const heading of [
      "## 为什么使用 MeanThis",
      "## 三步工作流",
      "## Agent 会收到什么",
      "## 让 Agent 帮你安装",
      "## 隐私与安全",
    ]) expect(chinese).toContain(heading);
    expect(english).toContain("./AGENT_INSTALL.md");
    expect(chinese).toContain("./AGENT_INSTALL_zh.md");
    expect(agentInstall).toContain("meanthis bridge doctor --json");
    expect(agentInstallChinese).toContain("meanthis bridge doctor --json");
    expect(rootManifest.scripts["setup:bridge:codex"])
      .toContain("meanthis bridge install --host codex --json");
    expect(rootManifest.scripts["start:bridge"]).toBe(
      agentDocsRoot === root
        ? "meanthis bridge start --json"
        : "node apps/cli/dist/index.js bridge start --json",
    );
    expect(privacy).toContain("permalink: /privacy/");
    expect(privacyChinese).toContain("permalink: /zh/privacy/");
    expect(privacy).toContain("Chrome Web Store User Data Policy");
    expect(privacyChinese).toContain("Chrome Web Store User Data Policy");
    expect(releasing).toContain("normal incremental commits and pull requests");
    expect(releasingChinese).toContain("正常的增量 commit 与 pull request");
    expect(config).toContain('baseurl: "/meanthis"');
    expect(releaseWorkflow).toContain('tags:\n      - "v*"');
    expect(releaseWorkflow).toContain("^v([0-9]+\\.[0-9]+\\.[0-9]+)$");
    expect(releaseWorkflow).toContain("npm run verify:version-alignment");
    expect(releaseWorkflow).toContain("npm run pack:extension");
    expect(releaseWorkflow).toContain("git merge-base --is-ancestor HEAD refs/remotes/origin/main");
    expect(releaseWorkflow).toContain('refs/tags/${GITHUB_REF_NAME}^{commit}');
    expect(releaseWorkflow).toContain("persist-credentials: false");
    expect(releaseWorkflow).toContain("contents: write");
    expect(releaseWorkflow).toContain("git diff --exit-code HEAD --");
    expect(releaseWorkflow).toContain("--verify-tag");
    expect(releaseWorkflow).toContain("--draft");
    expect(releaseWorkflow).not.toContain("--draft=false");
    expect(releaseWorkflow).not.toContain("--clobber");
    expect(releaseWorkflow).toContain("$prefix.zip");
    expect(releaseWorkflow).toContain("$prefix.manifest.json");
    expect(releaseWorkflow).toContain("$prefix.sha256");
    for (const line of releaseWorkflow.split("\n").filter((value) => value.includes("uses:"))) {
      expect(line).toMatch(/uses: [^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/u);
    }
    for (const excluded of ["apps", "packages", "scripts", "tools"]) {
      expect(config).toContain(`  - ${excluded}`);
    }

    for (const path of [
      "apps/extension-mv3/store",
      "benchmarks",
      "docs/dogfood",
      "docs/plans",
      "tools/upstream-conformance",
      "tools/vite-source-map",
    ]) expect(existsSync(join(root, ...path.split("/"))), path).toBe(false);
  });
});
