import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildDevelopmentReloadPage,
  normalizeDevelopmentReloadResult,
  parseDevelopmentReloadArguments,
  startControlServer,
} from "./development-reload.mjs";

const bootstrapToken = "b".repeat(43);
const controlToken = "c".repeat(43);
const resultToken = "r".repeat(43);

async function startTestControl(
  overrides: Partial<Parameters<typeof startControlServer>[0]> = {},
) {
  return startControlServer({
    bootstrapToken,
    buildId: "build-current",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    page: buildDevelopmentReloadPage(),
    port: 0,
    resultToken,
    timeoutMs: 2_000,
    token: controlToken,
    ...overrides,
  });
}

function endpoint(controlUrl: string, pathname: string) {
  const url = new URL(controlUrl);
  url.hash = "";
  url.pathname = pathname;
  return url;
}

async function executeGeneratedHelper({
  authorizeOk,
  observedBuildId,
  resultOk,
}: {
  authorizeOk: boolean;
  observedBuildId: string;
  resultOk: boolean;
}) {
  const page = buildDevelopmentReloadPage();
  const script = page.match(/<script nonce="meanthis-dev">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Development helper script is missing.");
  const messages: Array<Record<string, unknown>> = [];
  const resultBodies: Array<Record<string, unknown>> = [];
  const statusNode = { textContent: "" };
  const historyCalls: unknown[][] = [];
  let closeCount = 0;
  let activeBuildId = observedBuildId;
  let resolveResultAttempt: (() => void) | undefined;
  const resultAttempted = new Promise<void>((resolve) => {
    resolveResultAttempt = resolve;
  });

  runInNewContext(script, {
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(
          _extensionId: string,
          message: Record<string, unknown>,
          callback: (response: unknown) => void,
        ) {
          messages.push(message);
          callback({
            buildId: activeBuildId,
            ...(message.action === "diagnostics" ? { events: [] } : {}),
            ok: true,
          });
          if (message.action === "reload") activeBuildId = "build-current";
        },
      },
    },
    clearTimeout() {},
    document: {
      querySelector() {
        return statusNode;
      },
    },
    fetch: async (input: string, init?: { body?: string }) => {
      if (input === "/bootstrap") {
        return {
          json: async () => ({
            buildId: "build-current",
            extensionId: "abcdefghijklmnopabcdefghijklmnop",
            resultToken,
            timeoutMs: 100,
            token: controlToken,
          }),
          ok: true,
          status: 200,
        };
      }
      if (input === "/authorize") {
        return { ok: authorizeOk, status: authorizeOk ? 204 : 403 };
      }
      if (input === "/result") {
        resultBodies.push(JSON.parse(init?.body ?? "null"));
        resolveResultAttempt?.();
        return { ok: resultOk, status: resultOk ? 204 : 400 };
      }
      throw new Error(`Unexpected helper request: ${input}`);
    },
    history: {
      replaceState(...args: unknown[]) {
        historyCalls.push(args);
      },
    },
    location: {
      hash: `#${bootstrapToken}`,
      pathname: "/reload",
      search: "",
    },
    queueMicrotask,
    setTimeout(callback: () => void) {
      queueMicrotask(callback);
      return 1;
    },
    window: {
      close() {
        closeCount += 1;
      },
    },
  });
  await resultAttempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { closeCount, historyCalls, messages, resultBodies, statusNode };
}

describe("development extension reload runner", () => {
  test("supports a no-open mode for reusing an already controlled Chrome", () => {
    expect(parseDevelopmentReloadArguments([
      "--no-open",
      "--timeout-ms",
      "60000",
      "--chrome-path",
      "C:\\Chrome\\chrome.exe",
      "--chrome-user-data-dir",
      "C:\\Chrome\\User Data",
      "--chrome-profile-directory",
      "Profile 2",
    ])).toEqual({
      chromePath: "C:\\Chrome\\chrome.exe",
      chromeProfileDirectory: "Profile 2",
      chromeUserDataDir: "C:\\Chrome\\User Data",
      openBrowser: false,
      timeoutMs: 60_000,
    });
    expect(parseDevelopmentReloadArguments([]))
      .toEqual({ openBrowser: true, timeoutMs: 15_000 });
    expect(() => parseDevelopmentReloadArguments(["--chrome-profile-directory"]))
      .toThrow(/requires a non-empty value/);
  });

  test("renders a generic one-shot bootstrap page with fail-closed terminal reporting", () => {
    const page = buildDevelopmentReloadPage();

    expect(page).toContain("chrome.runtime.sendMessage");
    expect(page).toContain("meanthis:development-runtime-control:v1");
    expect(page).toContain("location.hash");
    expect(page).toContain("history.replaceState");
    expect(page).toContain('fetch("/bootstrap"');
    expect(page).toContain("response.ok");
    expect(page).toContain("terminalReported");
    expect(page).toContain("observedBuildId");
    expect(page).toContain("targetBuildId");
    expect(page).not.toContain(controlToken);
    expect(page).not.toContain(resultToken);
    expect(page).not.toContain(bootstrapToken);
    const script = page.match(/<script nonce="meanthis-dev">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTypeOf("string");
    expect(() => new Function(script!)).not.toThrow();
  });

  test("executes the generated helper without stale reload or false-success close", async () => {
    const stale = await executeGeneratedHelper({
      authorizeOk: false,
      observedBuildId: "build-old",
      resultOk: true,
    });
    expect(stale.historyCalls).toHaveLength(1);
    expect(stale.messages.map((message) => message.action)).toEqual(["ping"]);
    expect(stale.resultBodies).toHaveLength(1);
    expect(stale.resultBodies[0]).toMatchObject({
      observedBuildId: "build-old",
      status: "failed",
    });
    expect(stale.closeCount).toBe(0);

    const rejectedReceipt = await executeGeneratedHelper({
      authorizeOk: true,
      observedBuildId: "build-current",
      resultOk: false,
    });
    expect(rejectedReceipt.messages.map((message) => message.action))
      .toEqual(["ping", "diagnostics"]);
    expect(rejectedReceipt.resultBodies).toHaveLength(1);
    expect(rejectedReceipt.resultBodies[0]).toMatchObject({
      observedBuildId: "build-current",
      status: "already_current",
    });
    expect(rejectedReceipt.closeCount).toBe(0);
    expect(rejectedReceipt.statusNode.textContent).toContain("Receipt rejected (400)");

    const authorizedReload = await executeGeneratedHelper({
      authorizeOk: true,
      observedBuildId: "build-old",
      resultOk: true,
    });
    expect(authorizedReload.messages.map((message) => message.action))
      .toEqual(["ping", "reload", "ping", "diagnostics"]);
    expect(authorizedReload.resultBodies).toHaveLength(1);
    expect(authorizedReload.resultBodies[0]).toMatchObject({
      observedBuildId: "build-current",
      status: "reloaded",
    });
    expect(authorizedReload.closeCount).toBe(1);
  });

  test("accepts only bounded terminal results bound to the current run", () => {
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      diagnostics: [{
        at: "2026-08-20T14:00:00.000Z",
        kind: "error",
        message: "background failed",
      }],
      observedBuildId: "build-2",
      resultToken: "result-token",
      status: "reloaded",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toEqual({
      buildId: "build-2",
      diagnostics: [{
        at: "2026-08-20T14:00:00.000Z",
        kind: "error",
        message: "background failed",
      }],
      observedBuildId: "build-2",
      status: "reloaded",
    });
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      detail: "runtime API unavailable",
      resultToken: "result-token",
      status: "bootstrap_required",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toEqual({
      buildId: "build-2",
      detail: "runtime API unavailable",
      status: "bootstrap_required",
    });
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      detail: "x".repeat(513),
      resultToken: "result-token",
      status: "failed",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toBeNull();
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      extra: true,
      resultToken: "result-token",
      status: "reloaded",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toBeNull();
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-1",
      observedBuildId: "build-1",
      resultToken: "result-token",
      status: "reloaded",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toBeNull();
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      observedBuildId: "build-2",
      resultToken: "wrong-token",
      status: "already_current",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toBeNull();
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      observedBuildId: "build-1",
      resultToken: "result-token",
      status: "reloaded",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toBeNull();

    const maximumDiagnostics = Array.from({ length: 32 }, (_, index) => ({
      at: "\0".repeat(64),
      kind: index % 2 === 0 ? "error" : "unhandledrejection",
      message: "\0".repeat(512),
    }));
    expect(normalizeDevelopmentReloadResult({
      buildId: "build-2",
      diagnostics: maximumDiagnostics,
      observedBuildId: "build-2",
      resultToken: "result-token",
      status: "already_current",
    }, {
      buildId: "build-2",
      resultToken: "result-token",
    })).toEqual({
      buildId: "build-2",
      diagnostics: maximumDiagnostics,
      observedBuildId: "build-2",
      status: "already_current",
    });
  });

  test("delivers secrets through a one-shot fragment capability and never the fixed GET", async () => {
    const control = await startTestControl();

    try {
      const browserUrl = new URL(control.controlUrl);
      expect(browserUrl.pathname).toBe("/reload");
      expect(browserUrl.search).toBe("");
      expect(browserUrl.hash).toBe(`#${bootstrapToken}`);

      const pageResponse = await fetch(control.controlUrl);
      const page = await pageResponse.text();
      expect(page).not.toContain(bootstrapToken);
      expect(page).not.toContain(controlToken);
      expect(page).not.toContain(resultToken);
      expect(pageResponse.headers.get("content-security-policy"))
        .toContain("frame-ancestors 'none'");

      const bootstrapUrl = endpoint(control.controlUrl, "/bootstrap");
      const bootstrapResponse = await fetch(bootstrapUrl, {
        body: JSON.stringify({ bootstrapToken }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(bootstrapResponse.status).toBe(200);
      await expect(bootstrapResponse.json()).resolves.toEqual({
        buildId: "build-current",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        resultToken,
        timeoutMs: 2_000,
        token: controlToken,
      });
      expect((await fetch(bootstrapUrl, {
        body: JSON.stringify({ bootstrapToken }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(409);
    } finally {
      await control.close();
    }
  });

  test("does not settle the control server from stale or unauthenticated receipts", async () => {
    const control = await startTestControl();
    const resultUrl = endpoint(control.controlUrl, "/result");
    const postResult = (body: unknown) => fetch(resultUrl, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    try {
      for (const invalidReceipt of [
        {
          buildId: "build-stale",
          observedBuildId: "build-stale",
          resultToken,
          status: "reloaded",
        },
        {
          buildId: "build-current",
          observedBuildId: "build-current",
          resultToken: "wrong-token",
          status: "already_current",
        },
        {
          buildId: "build-current",
          observedBuildId: "build-current",
          status: "already_current",
        },
        {
          observedBuildId: "build-current",
          resultToken,
          status: "already_current",
        },
      ]) {
        const response = await postResult(invalidReceipt);
        expect(response.status).toBe(400);
      }

      const earlyState = await Promise.race([
        control.result.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(earlyState).toBe("pending");

      const response = await postResult({
        buildId: "build-current",
        observedBuildId: "build-current",
        resultToken,
        status: "already_current",
      });
      expect(response.status).toBe(204);
      await expect(control.result).resolves.toEqual({
        buildId: "build-current",
        observedBuildId: "build-current",
        status: "already_current",
      });
    } finally {
      await control.close();
    }
  });

  test("authorizes only one current-run reload and accepts the maximum legal receipt", async () => {
    const control = await startTestControl();
    const bootstrapUrl = endpoint(control.controlUrl, "/bootstrap");
    const authorizeUrl = endpoint(control.controlUrl, "/authorize");
    const resultUrl = endpoint(control.controlUrl, "/result");
    const maximumDiagnostics = Array.from({ length: 32 }, (_, index) => ({
      at: "\0".repeat(64),
      kind: index % 2 === 0 ? "error" : "unhandledrejection",
      message: "\0".repeat(512),
    }));

    try {
      expect((await fetch(bootstrapUrl, {
        body: JSON.stringify({ bootstrapToken }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(200);
      expect((await fetch(authorizeUrl, {
        body: JSON.stringify({
          observedBuildId: "build-old",
          resultToken: "wrong-token",
          targetBuildId: "build-current",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(400);
      const authorization = {
        observedBuildId: "build-old",
        resultToken,
        targetBuildId: "build-current",
      };
      expect((await fetch(authorizeUrl, {
        body: JSON.stringify(authorization),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(204);
      expect((await fetch(authorizeUrl, {
        body: JSON.stringify(authorization),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(409);

      const receipt = {
        buildId: "build-current",
        diagnostics: maximumDiagnostics,
        observedBuildId: "build-current",
        resultToken,
        status: "reloaded",
      };
      expect(JSON.stringify(receipt).length).toBeGreaterThan(2_048);
      expect(JSON.stringify(receipt).length).toBeLessThanOrEqual(128 * 1_024);
      expect((await fetch(resultUrl, {
        body: JSON.stringify(receipt),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(204);
      await expect(control.result).resolves.toEqual({
        buildId: "build-current",
        diagnostics: maximumDiagnostics,
        observedBuildId: "build-current",
        status: "reloaded",
      });
      expect((await fetch(resultUrl, {
        body: JSON.stringify(receipt),
        headers: { "content-type": "application/json" },
        method: "POST",
      })).status).toBe(409);
    } finally {
      await control.close();
    }
  });

  test("fails a concurrent control-port claim before either result promise can reject", async () => {
    const first = await startTestControl();
    const occupiedPort = Number(new URL(first.controlUrl).port);

    try {
      await expect(startTestControl({
        bootstrapToken: "x".repeat(43),
        port: occupiedPort,
        resultToken: "y".repeat(43),
      })).rejects.toThrow(/control port .* unavailable.*EADDRINUSE/i);
    } finally {
      await first.close();
    }
  });
});
