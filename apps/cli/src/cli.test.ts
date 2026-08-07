import { readFileSync } from "node:fs";
import {
  CAPTURE_SESSION_FILE_MAX_BYTES,
  hydrateCaptureSessionFile,
} from "@meanthis/hub-core";
import { describe, expect, test } from "vitest";
import { runCli, type CliIo } from "./cli";

const twoAttachmentFixture = readFileSync(
  new URL("../fixtures/two-attachment.capture-session.json", import.meta.url),
  "utf8",
);
const agentSafeFixture = readFileSync(
  new URL("../fixtures/agent-safe.capture-session.json", import.meta.url),
  "utf8",
);

describe("MeanThis CLI", () => {
  test("writes an agent-safe summary envelope without full payloads", async () => {
    const io = createTestIo({ "session.json": twoAttachmentFixture });
    const exitCode = await runCli(["summary", "--input", "session.json"], io);

    expect(exitCode).toBe(0);
    expect(io.stderr).toBe("");
    const output = JSON.parse(io.stdout);
    expect(output).toEqual(
      expect.objectContaining({
        schemaVersion: "0.1.0",
        kind: "ui-attach.session-summary",
        ok: true,
      }),
    );
    expect(output.data.attachmentCount).toBe(2);
    expect(output.data.items[0].routingHint).toMatchObject({
      pageInstanceId: "chromium-tab:1:frame:0",
      route: "https://app.example.test/billing",
    });
    expect(JSON.stringify(output)).not.toContain("attachment\":");
    expect(io.stdout).not.toContain("?token=secret");
    expect(io.stdout).not.toContain("#billing");
    expect(io.stdout).not.toContain("ada@example.com");
    expect(io.stdout).not.toContain("sk-test-1234567890");
    expectSingleJsonLine(io.stdout);

    const loaded = hydrateCaptureSessionFile(JSON.parse(twoAttachmentFixture));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const direct = loaded.hub.summarizeSession(loaded.sessionId, {
      disclosureMode: "agent_safe",
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const { ok: _ok, ...directData } = direct;
    expect(output.data).toEqual(directData);
  });

  test("returns only one selected disclosure-derived attachment", async () => {
    const io = createTestIo({ "session.json": twoAttachmentFixture });
    const exitCode = await runCli(
      [
        "attachment",
        "--input",
        "session.json",
        "--id",
        "att_save",
        "--disclosure",
        "agent_safe",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(io.stdout);
    expect(output.kind).toBe("ui-attach.attachment");
    expect(output.data.attachment.policy.disclosureMode).toBe("agent_safe");
    expect(output.data.attachment.policy.redactedFields).toContain("source.url");
    expect(Object.keys(output.data).sort()).toEqual(
      [
        "id",
        "createdAt",
        "labels",
        "origin",
        "pageUrl",
        "pageTitle",
        "capturedAt",
        "routingHint",
        "attachment",
        "replayAttempts",
      ].sort(),
    );
    expect(output.data.sourceRecord).toBeUndefined();
    expect(output.data.intent).toBeUndefined();
    expect(output.data.markdown).toBeUndefined();
    expect(output.data.summary).toBeUndefined();
    expect(new URL(output.data.pageUrl).search).toBe("");
    expect(new URL(output.data.pageUrl).hash).toBe("");
    expect(output.data.routingHint).toMatchObject({
      pageInstanceId: "chromium-tab:1:frame:0",
      route: "https://app.example.test/billing",
    });
    expect(io.stdout).not.toContain("?token=secret");
    expect(io.stdout).not.toContain("#billing");
    expect(io.stdout).not.toContain("ada@example.com");
    expect(io.stdout).not.toContain("sk-test-1234567890");
  });

  test("reads the capture session from stdin when --input is dash", async () => {
    const io = createTestIo({}, agentSafeFixture);
    const exitCode = await runCli(
      ["attachment", "--input", "-", "--id", "att_save", "--disclosure", "agent_safe"],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderr).toBe("");
    expect(JSON.parse(io.stdout)).toMatchObject({
      kind: "ui-attach.attachment",
      ok: true,
      data: { id: "att_save" },
    });
  });

  test.each(["developer_diagnostic", "full_debug"] as const)(
    "honors an explicit %s read when the full-debug source permits it",
    async (disclosureMode) => {
      const io = createTestIo({ "session.json": twoAttachmentFixture });
      const exitCode = await runCli(
        [
          "attachment",
          "--input",
          "session.json",
          "--id",
          "att_save",
          "--disclosure",
          disclosureMode,
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdout).data.attachment.policy.disclosureMode).toBe(
        disclosureMode,
      );
    },
  );

  test("builds JSON and Markdown bundles from only the selected ids", async () => {
    const jsonIo = createTestIo({ "session.json": twoAttachmentFixture });
    expect(
      await runCli(
        [
          "bundle",
          "--input",
          "session.json",
          "--id",
          "att_save",
          "--id",
          "att_cancel",
          "--intent",
          "Move A below B.",
        ],
        jsonIo,
      ),
    ).toBe(0);
    const jsonOutput = JSON.parse(jsonIo.stdout);
    expect(jsonOutput.kind).toBe("ui-attach.prompt-bundle");
    expect(jsonOutput.data.attachmentIds).toEqual(["att_save", "att_cancel"]);
    expect(jsonOutput.data.routingHints).toEqual([
      expect.objectContaining({
        attachmentId: "att_save",
        label: "A",
        routingHint: expect.objectContaining({
          pageInstanceId: "chromium-tab:1:frame:0",
          route: "https://app.example.test/billing",
        }),
      }),
      expect.objectContaining({ attachmentId: "att_cancel", label: "B" }),
    ]);
    expect(jsonOutput.data.markdown).toContain("Move A below B.");
    expect(jsonOutput.data.markdown).toContain("## Local Page Routing");
    expect(jsonIo.stdout).not.toContain("?token=secret");
    expect(jsonIo.stdout).not.toContain("#billing");
    expectSingleJsonLine(jsonIo.stdout);
    expect(JSON.stringify(jsonOutput)).not.toContain("Persist billing changes.");
    expect(JSON.stringify(jsonOutput)).not.toContain("Discard billing changes.");

    const markdownIo = createTestIo({ "session.json": twoAttachmentFixture });
    expect(
      await runCli(
        [
          "bundle",
          "--input",
          "session.json",
          "--id",
          "att_save",
          "--format",
          "markdown",
        ],
        markdownIo,
      ),
    ).toBe(0);
    expect(markdownIo.stdout.startsWith("# MeanThis Capture Bundle")).toBe(true);
    expect(markdownIo.stdout.endsWith("\n")).toBe(true);
    expect(markdownIo.stdout).not.toContain('"kind":"ui-attach.prompt-bundle"');
    expect(markdownIo.stdout).not.toContain("Cancel");
    expect(markdownIo.stdout).not.toContain("Persist billing changes.");
    expect(markdownIo.stdout).not.toContain("Discard billing changes.");
  });

  test("includes a fixture-matching intent only when explicitly supplied by the command", async () => {
    const io = createTestIo({ "session.json": twoAttachmentFixture });

    expect(
      await runCli(
        [
          "bundle",
          "--input",
          "session.json",
          "--id",
          "att_save",
          "--intent",
          "Persist billing changes.",
        ],
        io,
      ),
    ).toBe(0);

    expect(JSON.parse(io.stdout).data.markdown).toContain("Persist billing changes.");
    expect(io.stdout).not.toContain("Discard billing changes.");
  });

  test("reads bundle intent from an explicit local intent file", async () => {
    const io = createTestIo({
      "session.json": twoAttachmentFixture,
      "intent.txt": "Move A below B.",
    });
    const exitCode = await runCli(
      [
        "bundle",
        "--input",
        "session.json",
        "--id",
        "att_save",
        "--intent-file",
        "intent.txt",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout).data.markdown).toContain("Move A below B.");
  });

  test("rejects invalid command arguments", async () => {
    await expectCliError(["summary"], {}, 2, "INVALID_ARGUMENTS");
  });

  test("rejects an unknown flag", async () => {
    await expectCliError(
      ["summary", "--input", "session.json", "--unknown"],
      { "session.json": twoAttachmentFixture },
      2,
      "INVALID_ARGUMENTS",
    );
  });

  test("rejects disclosure for summary", async () => {
    await expectCliError(
      ["summary", "--input", "session.json", "--disclosure", "agent_safe"],
      { "session.json": twoAttachmentFixture },
      2,
      "INVALID_ARGUMENTS",
    );
  });

  test("rejects format for attachment", async () => {
    await expectCliError(
      [
        "attachment",
        "--input",
        "session.json",
        "--id",
        "att_save",
        "--format",
        "json",
      ],
      { "session.json": twoAttachmentFixture },
      2,
      "INVALID_ARGUMENTS",
    );
  });

  test("reports session input read failures", async () => {
    await expectCliError(
      ["summary", "--input", "session.json"],
      {},
      3,
      "INPUT_READ_FAILED",
    );
  });

  test("reports malformed JSON", async () => {
    await expectCliError(
      ["summary", "--input", "session.json"],
      { "session.json": "{" },
      3,
      "INVALID_JSON",
    );
  });

  test("rejects an oversized capture session returned by injected file IO", async () => {
    const io = createTestIo({
      "session.json": "x".repeat(CAPTURE_SESSION_FILE_MAX_BYTES + 1),
    });

    expect(await runCli(["summary", "--input", "session.json"], io)).toBe(3);
    expectErrorIo(io, "INVALID_SESSION_FILE");
  });

  test("rejects an oversized capture session returned by injected stdin IO", async () => {
    const io = createTestIo({}, "x".repeat(CAPTURE_SESSION_FILE_MAX_BYTES + 1));

    expect(await runCli(["summary", "--input", "-"], io)).toBe(3);
    expectErrorIo(io, "INVALID_SESSION_FILE");
  });

  test("returns safe session validation issues", async () => {
    const invalid = JSON.parse(twoAttachmentFixture) as { schemaVersion: string };
    invalid.schemaVersion = "9.0.0";
    const io = createTestIo({ "session.json": JSON.stringify(invalid) });

    expect(await runCli(["summary", "--input", "session.json"], io)).toBe(3);
    expectErrorIo(io, "INVALID_SESSION_FILE");
    expect(JSON.parse(io.stderr).error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "schemaVersion" })]),
    );
  });

  test("does not echo sensitive attachment ids in validation issues", async () => {
    const secretId = "att_sk-test-1234567890";
    const invalid = JSON.parse(twoAttachmentFixture) as {
      session: { attachments: Array<{ id: string }> };
    };
    invalid.session.attachments[0].id = secretId;
    invalid.session.attachments[1].id = secretId;
    const io = createTestIo({ "session.json": JSON.stringify(invalid) });

    expect(await runCli(["summary", "--input", "session.json"], io)).toBe(3);

    expectErrorIo(io, "INVALID_SESSION_FILE");
    expect(io.stderr).not.toContain(secretId);
    expect(JSON.parse(io.stderr).error.issues).toContainEqual({
      path: "session.attachments[1].id",
      message: "Duplicate attachment id.",
    });
  });

  test("rejects unknown attachment data before writing a selected attachment", async () => {
    const invalid = JSON.parse(twoAttachmentFixture) as {
      session: {
        attachments: Array<{
          sourceRecord: { attachment: { element: Record<string, unknown> } };
        }>;
      };
    };
    invalid.session.attachments[0].sourceRecord.attachment.element[
      "sk-test-1234567890"
    ] = "token-secret-1234567890";
    const io = createTestIo({ "session.json": JSON.stringify(invalid) });

    expect(
      await runCli(
        ["attachment", "--input", "session.json", "--id", "att_save"],
        io,
      ),
    ).toBe(3);

    expectErrorIo(io, "INVALID_SESSION_FILE");
    expect(JSON.parse(io.stderr).error.issues).toContainEqual({
      path: "session.attachments[0].sourceRecord.attachment.element.[unknownField:0]",
      message: "Unknown field.",
    });
    expect(io.stderr).not.toContain("sk-test-1234567890");
    expect(io.stderr).not.toContain("token-secret-1234567890");
  });

  test("reports unknown attachment ids", async () => {
    await expectCliError(
      ["attachment", "--input", "session.json", "--id", "missing"],
      { "session.json": twoAttachmentFixture },
      4,
      "ATTACHMENT_NOT_FOUND",
    );
  });

  test("does not echo a missing sensitive attachment id", async () => {
    const secretId = "att_sk-test-1234567890";
    const io = createTestIo({ "session.json": twoAttachmentFixture });

    expect(
      await runCli(
        ["attachment", "--input", "session.json", "--id", secretId],
        io,
      ),
    ).toBe(4);

    expectErrorIo(io, "ATTACHMENT_NOT_FOUND");
    expect(JSON.parse(io.stderr).error.message).toBe("Capture attachment not found.");
    expect(io.stderr).not.toContain(secretId);
  });

  test("denies disclosure upgrades from an agent-safe source", async () => {
    await expectCliError(
      [
        "attachment",
        "--input",
        "session.json",
        "--id",
        "att_save",
        "--disclosure",
        "full_debug",
      ],
      { "session.json": agentSafeFixture },
      4,
      "DISCLOSURE_UPGRADE_DENIED",
    );
  });

  test("rejects mutually exclusive bundle intent arguments", async () => {
    await expectCliError(
      [
        "bundle",
        "--input",
        "session.json",
        "--id",
        "att_save",
        "--intent",
        "Move A below B.",
        "--intent-file",
        "intent.txt",
      ],
      { "session.json": twoAttachmentFixture, "intent.txt": "Move A below B." },
      2,
      "INVALID_ARGUMENTS",
    );
  });

  test("rejects an oversized intent file returned by injected file IO", async () => {
    const io = createTestIo({
      "session.json": twoAttachmentFixture,
      "intent.txt": "x".repeat(262_145),
    });

    expect(await runCli([
      "bundle",
      "--input",
      "session.json",
      "--id",
      "att_save",
      "--intent-file",
      "intent.txt",
    ], io)).toBe(2);
    expectErrorIo(io, "INVALID_ARGUMENTS");
  });

  test("does not modify the input session text or parsed source data", async () => {
    const files = { "session.json": twoAttachmentFixture };
    const beforeText = files["session.json"];
    const beforeSource = structuredClone(JSON.parse(beforeText));
    const io = createTestIo(files);

    expect(await runCli(["summary", "--input", "session.json"], io)).toBe(0);

    expect(files["session.json"]).toBe(beforeText);
    expect(JSON.parse(files["session.json"])).toEqual(beforeSource);
  });
});

function createTestIo(
  files: Record<string, string>,
  stdinText?: string,
): CliIo & { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  return {
    async readTextFile(path: string): Promise<string> {
      if (!(path in files)) {
        throw new Error(`Missing fixture: ${path}`);
      }
      return files[path];
    },
    async readStdinText(): Promise<string> {
      if (stdinText === undefined) throw new Error("Missing stdin fixture.");
      return stdinText;
    },
    writeStdout(value: string): void {
      stdout += value;
    },
    writeStderr(value: string): void {
      stderr += value;
    },
    get stdout(): string {
      return stdout;
    },
    get stderr(): string {
      return stderr;
    },
  };
}

async function expectCliError(
  args: string[],
  files: Record<string, string>,
  exitCode: number,
  code: string,
): Promise<void> {
  const io = createTestIo(files);
  expect(await runCli(args, io)).toBe(exitCode);
  expectErrorIo(io, code);
}

function expectErrorIo(
  io: { stdout: string; stderr: string },
  code: string,
): void {
  expect(io.stdout).toBe("");
  expect(io.stderr.endsWith("\n")).toBe(true);
  expect(io.stderr.split("\n").filter(Boolean)).toHaveLength(1);
  const output = JSON.parse(io.stderr);
  expect(output).toEqual(
    expect.objectContaining({
      schemaVersion: "0.1.0",
      kind: "ui-attach.error",
      ok: false,
      error: expect.objectContaining({ code }),
    }),
  );
  expect(io.stderr).not.toContain("Error:");
  expect(io.stderr).not.toContain(" at ");
}

function expectSingleJsonLine(value: string): void {
  expect(value).toMatch(/^[^\r\n]+\n$/);
  expect(() => JSON.parse(value.slice(0, -1))).not.toThrow();
}
