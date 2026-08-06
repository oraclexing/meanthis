import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const externalTargetPath = resolve("apps/demo-web/public/external-target.html");
const compatibilityFixturePath = resolve("apps/demo-web/public/compatibility-fixtures.html");
const compatibilityIframePath = resolve("apps/demo-web/public/compatibility-iframe.html");
const demoIndexPath = resolve("apps/demo-web/index.html");

describe("external target harness", () => {
  it("serves a standalone target page without importing ui-attach code", async () => {
    const html = await readFile(externalTargetPath, "utf8");

    expect(html).toContain("data-external-target");
    expect(html).toContain("data-testid=\"approve-invoice\"");
    expect(html).toContain("Approve invoice");
    expect(html).not.toContain("@ui-attach");
    expect(html).not.toContain("/src/main");
    expect(html).not.toContain("ui-attach-runtime");
    expect(html).not.toContain("data-ui-attach-demo");
    expect(html).not.toContain("<script");
  });

  it("links to the external target from the main demo", async () => {
    const html = await readFile(demoIndexPath, "utf8");

    expect(html).toContain("id=\"external-target-link\"");
    expect(html).toContain("href=\"/external-target.html?token=external-secret#billing\"");
    expect(html).toContain("id=\"compatibility-fixtures-link\"");
    expect(html).toContain("href=\"/compatibility-fixtures.html?token=compat-secret#fixtures\"");
  });

  it("keeps extension target guidance separate from standalone demo controls", async () => {
    const html = await readFile(demoIndexPath, "utf8");

    expect(html).toContain("id=\"standalone-demo-tools\"");
    expect(html).toContain("id=\"standalone-demo-output\"");
    expect(html).toContain("id=\"extension-demo-guide\" data-ui-attach-ignore hidden");
    expect(html).toContain("Choose <strong>Add elements</strong> in MeanThis");
    expect(html).toContain("#extension-demo-guide[hidden]");
  });

  it("serves compatibility fixtures for extension smoke testing", async () => {
    const html = await readFile(compatibilityFixturePath, "utf8");
    const iframeHtml = await readFile(compatibilityIframePath, "utf8");

    expect(html).toContain("data-compatibility-fixtures");
    expect(html).toContain("data-testid=\"archive-report\"");
    expect(html).toContain("data-testid=\"rotate-demo-secret\"");
    expect(html).toContain("sk-test-1234567890");
    expect(html).toContain("aria-label=\"Edit billing plan\"");
    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("id=\"shadow-host\"");
    expect(html).toContain("src=\"/compatibility-iframe.html\"");
    expect(html).not.toContain("@ui-attach");
    expect(html).not.toContain("data-ui-attach-demo");
    expect(iframeHtml).toContain("data-compatibility-iframe");
    expect(iframeHtml).toContain("data-testid=\"iframe-submit\"");
  });
});
