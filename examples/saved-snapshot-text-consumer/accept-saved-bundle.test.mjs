import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  deriveStoredSessionHandoff,
  serializeSavedSnapshotPromptBundleJson,
} from "../../apps/extension-mv3/src/session-file.ts";
import {
  SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES,
} from "./index.mjs";
import {
  runSavedSnapshotPublicConsumerConnector,
} from "./accept-saved-bundle.mjs";

const INVALID_ARGUMENTS = "Saved-snapshot connector arguments were invalid.\n";
const NOT_ACCEPTED = "Saved-snapshot bundle was not accepted.\n";
const INTERNAL_ERROR = "Saved-snapshot connector failed.\n";

describe("saved snapshot public-consumer file/stdin connector", () => {
  test("produces byte-identical combined acceptance from stdin and a file input", async () => {
    const copiedJson = productionCopiedBundleJson();
    const stdin = connectorIo([Buffer.from(copiedJson)]);
    const file = connectorIo([Buffer.from(copiedJson)]);

    expect(await runSavedSnapshotPublicConsumerConnector([], stdin.io)).toBe(0);
    expect(
      await runSavedSnapshotPublicConsumerConnector(
        ["--input", "saved-bundle.json"],
        file.io,
      ),
    ).toBe(0);

    expect(stdin.openInput).toHaveBeenCalledWith("-");
    expect(file.openInput).toHaveBeenCalledWith("saved-bundle.json");
    expect(file.stderr).toBe("");
    expect(file.stdout).toBe(stdin.stdout);
    expect(file.stdout.endsWith("\n")).toBe(true);
    const output = JSON.parse(file.stdout);
    expect(Object.keys(output).sort()).toEqual([
      "acceptedContext",
      "consumerReceipt",
    ]);
    expect(output.acceptedContext).toMatchObject({
      kind: "ui-attach.saved-snapshot-attachment-context",
      attachmentCount: 2,
      authority: {
        status: "not_rechecked",
        routingPolicy: "omitted",
      },
    });
    expect(output.consumerReceipt).toMatchObject({
      kind: "ui-attach.saved-snapshot-public-consumer-receipt",
      consumerContextSha256: output.acceptedContext.contentSha256,
      consumerAttachmentCount: 2,
      consumerAuthorityStatus: "not_rechecked",
      consumerRoutingPolicy: "omitted",
      consumerStatus: "accepted",
      modelFieldsUsedCount: 0,
    });
    expect(JSON.stringify(output.consumerReceipt)).not.toContain("markdown");
    expect(output.acceptedContext).not.toHaveProperty("consumerReceipt");
  });

  test("accepts an optional UTF-8 BOM after counting its raw bytes", async () => {
    const copiedJson = Buffer.from(productionCopiedBundleJson(), "utf8");
    const plain = connectorIo([copiedJson]);
    const withBom = connectorIo([
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), copiedJson]),
    ]);

    expect(await runSavedSnapshotPublicConsumerConnector([], plain.io)).toBe(0);
    expect(await runSavedSnapshotPublicConsumerConnector([], withBom.io)).toBe(0);
    expect(withBom.stdout).toBe(plain.stdout);
    expect(withBom.stderr).toBe("");
  });

  test.each([
    ["invalid JSON", [Buffer.from('{"private-sentinel":')]],
    ["invalid UTF-8", [Buffer.from([0xff, 0xfe])]],
    ["empty input", []],
    [
      "oversized input",
      [
        Buffer.alloc(SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES, 0x20),
        Buffer.from("{}"),
      ],
    ],
  ])("rejects %s without echoing local content", async (_name, chunks) => {
    const fixture = connectorIo(chunks);

    expect(await runSavedSnapshotPublicConsumerConnector([], fixture.io)).toBe(3);

    expect(fixture.stdout).toBe("");
    expect(fixture.stderr).toBe(NOT_ACCEPTED);
    expect(fixture.stderr).not.toContain("private-sentinel");
  });

  test("rejects an unreadable file without echoing its path", async () => {
    const privatePath = "C:\\private-sentinel\\saved-bundle.json";
    const fixture = connectorIo([], {
      openInput: vi.fn(() => {
        throw new Error(`ENOENT: ${privatePath}`);
      }),
    });

    expect(
      await runSavedSnapshotPublicConsumerConnector(
        ["--input", privatePath],
        fixture.io,
      ),
    ).toBe(3);
    expect(fixture.stdout).toBe("");
    expect(fixture.stderr).toBe(NOT_ACCEPTED);
    expect(fixture.stderr).not.toContain(privatePath);
  });

  test("turns an asynchronous stdout failure into a fixed internal error", async () => {
    const privatePath = "D:\\private-sentinel\\accept-saved-bundle.mjs";
    const fixture = connectorIo([Buffer.from(productionCopiedBundleJson())], {
      writeStdout: vi.fn(async () => {
        throw new Error(`EPIPE at ${privatePath}`);
      }),
    });

    expect(await runSavedSnapshotPublicConsumerConnector([], fixture.io)).toBe(1);
    expect(fixture.stderr).toBe(INTERNAL_ERROR);
    expect(fixture.stderr).not.toContain(privatePath);
  });

  test.each([
    ["unknown option", ["--unknown", "private-sentinel"]],
    ["missing input value", ["--input"]],
    ["extra positional value", ["saved-bundle.json"]],
  ])("rejects invalid arguments: %s", async (_name, args) => {
    const fixture = connectorIo([]);

    expect(await runSavedSnapshotPublicConsumerConnector(args, fixture.io)).toBe(2);

    expect(fixture.openInput).not.toHaveBeenCalled();
    expect(fixture.stdout).toBe("");
    expect(fixture.stderr).toBe(INVALID_ARGUMENTS);
    expect(fixture.stderr).not.toContain("private-sentinel");
  });
});

function connectorIo(chunks, overrides = {}) {
  let stdout = "";
  let stderr = "";
  const openInput = overrides.openInput ?? vi.fn(() => Readable.from(chunks));
  return {
    openInput,
    io: {
      openInput,
      writeStdout: overrides.writeStdout ?? ((value) => {
        stdout += value;
      }),
      writeStderr: overrides.writeStderr ?? ((value) => {
        stderr += value;
      }),
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function productionCopiedBundleJson() {
  const file = JSON.parse(readFileSync(
    new URL(
      "../../apps/extension-mv3/fixtures/two-element.capture-session.json",
      import.meta.url,
    ),
    "utf8",
  ));
  const handoff = deriveStoredSessionHandoff(file, file.session.origin, "epoch-1");
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) throw new Error("Production saved-bundle fixture was invalid.");
  return serializeSavedSnapshotPromptBundleJson(handoff.value.bundle);
}
