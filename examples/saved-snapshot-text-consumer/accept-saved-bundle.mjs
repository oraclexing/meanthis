#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptSavedSnapshotTextConsumerBundleJson,
  SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES,
} from "./index.mjs";

const INVALID_ARGUMENTS = "Saved-snapshot connector arguments were invalid.\n";
const NOT_ACCEPTED = "Saved-snapshot bundle was not accepted.\n";
const INTERNAL_ERROR = "Saved-snapshot connector failed.\n";
const GUARDED_PROCESS_STREAMS = new WeakSet();

const defaultIo = Object.freeze({
  openInput(input) {
    return input === "-" ? process.stdin : createReadStream(input);
  },
  writeStdout(value) {
    return writeProcessStream(process.stdout, value);
  },
  writeStderr(value) {
    return writeProcessStream(process.stderr, value);
  },
});

export async function runSavedSnapshotPublicConsumerConnector(args, io = defaultIo) {
  let input;
  try {
    input = parseInput(args);
  } catch {
    await writeFixedError(io, INVALID_ARGUMENTS);
    return 2;
  }

  let text;
  try {
    const stream = io.openInput(input);
    text = await readBoundedUtf8(stream);
  } catch {
    await writeFixedError(io, NOT_ACCEPTED);
    return 3;
  }

  let acceptance;
  try {
    acceptance = acceptSavedSnapshotTextConsumerBundleJson(text);
  } catch {
    await writeFixedError(io, INTERNAL_ERROR);
    return 1;
  }
  if (acceptance === null) {
    await writeFixedError(io, NOT_ACCEPTED);
    return 3;
  }

  try {
    await io.writeStdout(`${JSON.stringify(acceptance, null, 2)}\n`);
    return 0;
  } catch {
    await writeFixedError(io, INTERNAL_ERROR);
    return 1;
  }
}

function parseInput(args) {
  if (!Array.isArray(args) || args.length === 0) return "-";
  if (
    args.length === 2 &&
    args[0] === "--input" &&
    typeof args[1] === "string" &&
    args[1].length > 0
  ) return args[1];
  throw new Error("invalid arguments");
}

async function readBoundedUtf8(stream) {
  if (stream?.[Symbol.asyncIterator] === undefined) {
    throw new Error("invalid input stream");
  }
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = toBuffer(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES) {
      throw new Error("input too large");
    }
    chunks.push(bytes);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  return decoder.decode(Buffer.concat(chunks, byteLength));
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error("invalid input chunk");
}

async function writeFixedError(io, message) {
  try {
    await io.writeStderr(message);
  } catch {
    // A closed stderr is a transport failure, not permission to emit a stack.
  }
}

function writeProcessStream(stream, value) {
  guardProcessStreamErrors(stream);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      callback(result);
    };
    const onError = (error) => finish(rejectPromise, error);
    stream.once("error", onError);
    try {
      stream.write(value, (error) => {
        if (error) finish(rejectPromise, error);
        else finish(resolvePromise);
      });
    } catch (error) {
      finish(rejectPromise, error);
    }
  });
}

function guardProcessStreamErrors(stream) {
  if (GUARDED_PROCESS_STREAMS.has(stream)) return;
  GUARDED_PROCESS_STREAMS.add(stream);
  stream.on("error", () => {
    // The awaited write reports the failure; this guard prevents Node's
    // default stack/path emission if the stream also emits after its callback.
  });
}

async function main() {
  process.exitCode = await runSavedSnapshotPublicConsumerConnector(
    process.argv.slice(2),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async () => {
    await writeFixedError(defaultIo, INTERNAL_ERROR);
    process.exitCode = 1;
  });
}
