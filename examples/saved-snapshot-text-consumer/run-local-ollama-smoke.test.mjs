import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseLocalOllamaSmokeArgs,
  runLocalOllamaSmoke,
} from "./run-local-ollama-smoke.mjs";

const MODEL = "hf.co/example/model:Q4_K_M";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saved snapshot local Ollama public smoke", () => {
  test("parses one explicit bounded local profile", () => {
    expect(parseLocalOllamaSmokeArgs(["--model", MODEL])).toEqual({
      model: MODEL,
      ollamaUrl: "http://127.0.0.1:11434",
      seed: 22,
      timeoutMs: 120_000,
    });
    expect(parseLocalOllamaSmokeArgs([
      "--model", MODEL,
      "--ollama-url", "http://127.0.0.1:11555/",
      "--seed", "7",
      "--timeout-ms", "30000",
    ])).toEqual({
      model: MODEL,
      ollamaUrl: "http://127.0.0.1:11555",
      seed: 7,
      timeoutMs: 30_000,
    });
  });

  test("rejects missing, duplicate, unknown, remote, and unbounded arguments", () => {
    for (const argv of [
      [],
      ["--model", MODEL, "--model", MODEL],
      ["--model", MODEL, "--unknown", "x"],
      ["--model", MODEL, "--ollama-url", "http://localhost:11434"],
      ["--model", MODEL, "--seed", "-1"],
      ["--model", MODEL, "--timeout-ms", "0"],
      ["--model", MODEL, "--timeout-ms", "600001"],
    ]) {
      expect(() => parseLocalOllamaSmokeArgs(argv))
        .toThrow("Invalid local Ollama smoke arguments.");
    }
  });

  test("runs the production saved-context path while keeping action-like text blocked", async () => {
    const fetchImpl = vi.fn(async (_url, request) => new Response(JSON.stringify({
      model: MODEL,
      done: true,
      response: '{"allowed":true,"action":"click now"}',
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(runLocalOllamaSmoke({
      model: MODEL,
      ollamaUrl: "http://127.0.0.1:11434",
      seed: 22,
      timeoutMs: 30_000,
    })).resolves.toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-local-ollama-summary",
      runtime: "ollama",
      model: MODEL,
      seed: 22,
      timeoutMs: 30_000,
      attachmentCount: 2,
      modelOutputStatus: "completed",
      effectiveBoundaryState: "blocked",
      decisionCode: "live_recheck_required",
      modelFieldsUsed: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test("fails visibly but without provider details when local generation is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("secret endpoint detail");
    }));

    await expect(runLocalOllamaSmoke({
      model: MODEL,
      ollamaUrl: "http://127.0.0.1:11434",
      seed: 22,
      timeoutMs: 30_000,
    })).rejects.toEqual(new Error("Local Ollama text-consumer smoke failed."));
  });
});
