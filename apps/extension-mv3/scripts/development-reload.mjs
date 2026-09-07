#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDevelopmentChromeLaunchArguments,
  revalidateDevelopmentChromeBinding,
  resolveDevelopmentChromeBinding,
} from "./development-chrome-profile.mjs";
import { MEANTHIS_CHROME_WEB_STORE_ID } from "./extension-identity.mjs";

const CONTROL_TYPE = "meanthis:development-runtime-control:v1";
const CONTROL_HOST = "127.0.0.1";
const CONTROL_PORT = 41731;
const CONTROL_URL = `http://${CONTROL_HOST}:${CONTROL_PORT}/reload`;
const DEFAULT_TIMEOUT_MS = 15_000;
// Covers the protocol maximum after worst-case JSON escaping (currently < 118 KiB).
const RESULT_BODY_LIMIT = 128 * 1_024;
const CONTROL_CSP = "default-src 'none'; script-src 'nonce-meanthis-dev'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const extensionDistPath = resolve(repositoryRoot, "apps/extension-mv3/dist");
const stateDirectory = resolve(repositoryRoot, ".ui-attach-local/extension-dev");
const tokenPath = join(stateDirectory, "reload-token");
const logPath = join(stateDirectory, "reload.jsonl");

export function buildDevelopmentReloadPage() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-meanthis-dev'; connect-src 'self'; style-src 'unsafe-inline'">
<title>MeanThis development reload</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;max-width:680px}pre{white-space:pre-wrap}</style>
<h1>MeanThis development reload</h1>
<pre id="status">Connecting to the development extension…</pre>
<script nonce="meanthis-dev">
void (async () => {
const statusNode = document.querySelector("#status");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isBoundedString = (value, maximumLength) =>
  typeof value === "string" && value.length > 0 && value.length <= maximumLength;
const isBootstrapConfig = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 5 &&
    ["buildId", "extensionId", "resultToken", "timeoutMs", "token"]
      .every((key) => keys.includes(key)) &&
    isBoundedString(value.buildId, 128) &&
    /^[a-p]{32}$/.test(value.extensionId) &&
    isBoundedString(value.resultToken, 128) &&
    Number.isSafeInteger(value.timeoutMs) &&
    value.timeoutMs > 0 &&
    value.timeoutMs <= 120_000 &&
    isBoundedString(value.token, 128);
};
const bootstrapToken = location.hash.startsWith("#") ? location.hash.slice(1) : "";
history.replaceState(null, "", location.pathname + location.search);
if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) {
  statusNode.textContent = "Missing or malformed development bootstrap capability.";
  return;
}
let config;
try {
  const response = await fetch("/bootstrap", {
    body: JSON.stringify({ bootstrapToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    statusNode.textContent = "Development bootstrap was rejected (" + response.status + ").";
    return;
  }
  config = await response.json();
} catch (error) {
  statusNode.textContent = "Development bootstrap failed: " + String(error).slice(0, 512);
  return;
}
if (!isBootstrapConfig(config)) {
  statusNode.textContent = "Development bootstrap returned an invalid configuration.";
  return;
}
const send = (message) => new Promise((resolve) => {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    resolve({ detail: "runtime_api_unavailable", ok: false });
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve({ detail: "message_timeout", ok: false });
  }, 1_000);
  try {
    chrome.runtime.sendMessage(config.extensionId, {
      ...message,
      token: config.token,
      type: "${CONTROL_TYPE}",
    }, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = chrome.runtime.lastError?.message;
      if (detail) {
        resolve({ detail: String(detail).slice(0, 512), ok: false });
        return;
      }
      resolve({ ok: response?.ok === true, response });
    });
  } catch (error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ detail: String(error).slice(0, 512), ok: false });
  }
});
const authorizeReload = async (observedBuildId) => {
  try {
    const response = await fetch("/authorize", {
      body: JSON.stringify({
        observedBuildId,
        resultToken: config.resultToken,
        targetBuildId: config.buildId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return response.ok
      ? { ok: true }
      : { detail: "reload_authorization_rejected_" + response.status, ok: false };
  } catch (error) {
    return { detail: String(error).slice(0, 512), ok: false };
  }
};
let terminalReported = false;
const report = async (result) => {
  if (terminalReported) return false;
  terminalReported = true;
  statusNode.textContent = JSON.stringify(result, null, 2);
  let response;
  try {
    response = await fetch("/result", {
      body: JSON.stringify({
        ...result,
        buildId: config.buildId,
        resultToken: config.resultToken,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    statusNode.textContent += "\\nReceipt delivery failed: " + String(error).slice(0, 512);
    return false;
  }
  if (!response.ok) {
    statusNode.textContent += "\\nReceipt rejected (" + response.status + ").";
    return false;
  }
  if (result.status === "reloaded" || result.status === "already_current") {
    setTimeout(() => window.close(), 250);
  }
  return true;
};
const deadline = Date.now() + config.timeoutMs;
let observedBuildId;
let reloadRequested = false;
let lastDetail = "extension_unreachable";
while (Date.now() < deadline) {
  const ping = await send({ action: "ping", targetBuildId: config.buildId });
  if (ping.ok && typeof ping.response?.buildId === "string") {
    observedBuildId = ping.response.buildId;
    if (observedBuildId === config.buildId) {
      const diagnosticsResponse = await send({
        action: "diagnostics",
        observedBuildId,
        targetBuildId: config.buildId,
      });
      const diagnostics = Array.isArray(diagnosticsResponse.response?.events)
        ? diagnosticsResponse.response.events
        : [];
      await report({
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        observedBuildId,
        status: reloadRequested ? "reloaded" : "already_current",
      });
      return;
    }
    if (!reloadRequested) {
      const authorization = await authorizeReload(observedBuildId);
      if (!authorization.ok) {
        await report({
          detail: authorization.detail ?? "reload_authorization_rejected",
          observedBuildId,
          status: "failed",
        });
        return;
      }
      reloadRequested = true;
      const reload = await send({
        action: "reload",
        observedBuildId,
        targetBuildId: config.buildId,
      });
      if (!reload.ok) {
        await report({
          detail: reload.detail ?? "reload_rejected",
          observedBuildId,
          status: "failed",
        });
        return;
      }
    }
  } else {
    lastDetail = ping.detail ?? "extension_unreachable";
  }
  await sleep(250);
}
if (!terminalReported && Date.now() >= deadline) {
  await report({
    detail: String(lastDetail).slice(0, 512),
    ...(observedBuildId ? { observedBuildId } : {}),
    status: observedBuildId ? "failed" : "bootstrap_required",
  });
}
})();
</script>
</html>`;
}

export function normalizeDevelopmentReloadResult(value, expected) {
  try {
    if (
      expected === null ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      !isBoundedString(expected.buildId, 128) ||
      !isBoundedString(expected.resultToken, 128)
    ) {
      return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ![
      "buildId",
      "detail",
      "diagnostics",
      "observedBuildId",
      "resultToken",
      "status",
    ].includes(key))) {
      return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    }
    const result = value;
    if (result.buildId !== expected.buildId || result.resultToken !== expected.resultToken) {
      return null;
    }
    if (!["already_current", "bootstrap_required", "failed", "reloaded"].includes(result.status)) {
      return null;
    }
    if ("detail" in result && !isBoundedString(result.detail, 512)) return null;
    if ("observedBuildId" in result && !isBoundedString(result.observedBuildId, 128)) return null;
    const diagnostics = "diagnostics" in result
      ? normalizeDiagnostics(result.diagnostics)
      : undefined;
    if ("diagnostics" in result && diagnostics === null) return null;
    if (
      ["already_current", "reloaded"].includes(result.status) &&
      result.observedBuildId !== expected.buildId
    ) {
      return null;
    }
    return {
      buildId: result.buildId,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(result.observedBuildId === undefined ? {} : { observedBuildId: result.observedBuildId }),
      status: result.status,
    };
  } catch {
    return null;
  }
}

async function main() {
  const options = parseDevelopmentReloadArguments(process.argv.slice(2));
  const chromeBinding = await resolveDevelopmentChromeBinding({
    chromePath: options.chromePath,
    chromeProfileDirectory: options.chromeProfileDirectory,
    chromeUserDataDir: options.chromeUserDataDir,
    expectedExtensionPath: extensionDistPath,
    extensionId: MEANTHIS_CHROME_WEB_STORE_ID,
  });
  await mkdir(stateDirectory, { recursive: true });
  const token = await readOrCreateToken();
  const buildId = `dev-${Date.now()}-${randomUUID()}`;
  const bootstrapToken = randomBytes(32).toString("base64url");
  const resultToken = randomBytes(32).toString("base64url");
  const page = buildDevelopmentReloadPage();
  const control = await startControlServer({
    bootstrapToken,
    buildId,
    extensionId: MEANTHIS_CHROME_WEB_STORE_ID,
    page,
    resultToken,
    timeoutMs: options.timeoutMs,
    token,
  });
  try {
    await logEvent({ buildId, event: "session_started" });
    await runExtensionBuild({ buildId, token });
    await logEvent({ buildId, event: "build_completed" });
    await revalidateDevelopmentChromeBinding(chromeBinding, {
      expectedExtensionPath: extensionDistPath,
      extensionId: MEANTHIS_CHROME_WEB_STORE_ID,
    });
    await logEvent({
      buildId,
      event: "chrome_profile_binding_revalidated",
      profileDirectory: chromeBinding.profileDirectory,
    });
    control.startTimeout();
    if (options.openBrowser) {
      openChrome(chromeBinding, control.controlUrl);
    } else {
      process.stdout.write(`${JSON.stringify({
        buildId,
        controlUrl: control.controlUrl,
        status: "waiting_for_browser",
      })}\n`);
    }
    const outcome = await control.result;
    await logEvent({ buildId, event: "browser_result", ...outcome });
    process.stdout.write(`${JSON.stringify({
      buildId,
      logPath,
      ...outcome,
    }, null, 2)}\n`);
    if (outcome.status === "bootstrap_required") {
      if (options.openBrowser) {
        openChrome(
          chromeBinding,
          `chrome://extensions/?id=${MEANTHIS_CHROME_WEB_STORE_ID}`,
        );
      }
      process.stderr.write(
        "MeanThis needs one manual extension reload to install the development control channel. Reload it once, then run this command again.\n",
      );
      process.exitCode = 2;
    } else if (outcome.status === "failed") {
      process.exitCode = 1;
    }
  } finally {
    await control.close();
  }
}

export function parseDevelopmentReloadArguments(args) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let openBrowser = true;
  const chromeOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument === "--timeout-ms") {
      const parsed = Number(args[index + 1]);
      if (!Number.isSafeInteger(parsed) || parsed < 2_000 || parsed > 120_000) {
        throw new Error("--timeout-ms must be an integer between 2000 and 120000.");
      }
      timeoutMs = parsed;
      index += 1;
      continue;
    }
    const chromeOption = {
      "--chrome-path": "chromePath",
      "--chrome-profile-directory": "chromeProfileDirectory",
      "--chrome-user-data-dir": "chromeUserDataDir",
    }[argument];
    if (chromeOption !== undefined) {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a non-empty value.`);
      }
      chromeOptions[chromeOption] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { ...chromeOptions, openBrowser, timeoutMs };
}

async function readOrCreateToken() {
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) {
      throw new Error("Development reload token is malformed.");
    }
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return token;
}

async function runExtensionBuild({ buildId, token }) {
  const npmExecPath = process.env.npm_execpath;
  const executable = npmExecPath ? process.execPath : "npm";
  const argumentsList = [
    ...(npmExecPath ? [npmExecPath] : []),
    "--workspace",
    "@meanthis/extension-mv3",
    "run",
    "build",
  ];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MEANTHIS_EXTENSION_DEV_BUILD_ID: buildId,
        MEANTHIS_EXTENSION_DEV_RELOAD_TOKEN: token,
      },
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Extension build failed (${signal ?? code ?? "unknown"}).`));
    });
  });
}

export async function startControlServer({
  bootstrapToken,
  buildId,
  extensionId,
  page,
  port = CONTROL_PORT,
  resultToken,
  timeoutMs,
  token,
}) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken) ||
    !isBoundedString(buildId, 128) ||
    !/^[a-p]{32}$/.test(extensionId) ||
    !isBoundedString(resultToken, 128) ||
    !isBoundedString(token, 128)
  ) {
    throw new Error("Development reload server configuration is invalid.");
  }
  if (typeof page !== "string" || page.length === 0) {
    throw new Error("Development reload server requires a helper page.");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Development reload server port is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Development reload server timeout is invalid.");
  }
  let settled = false;
  let bootstrapUsed = false;
  let reloadAuthorized = false;
  let timer;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
  });
  void result.catch(() => {});
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", CONTROL_URL);
    if (request.method === "GET" && url.pathname === "/reload") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy": CONTROL_CSP,
        "content-type": "text/html; charset=utf-8",
      });
      response.end(page);
      return;
    }
    if (request.method === "POST" && url.pathname === "/bootstrap") {
      try {
        const raw = await readBoundedRequestBody(request, 512);
        const suppliedToken = normalizeSingleStringField(JSON.parse(raw), "bootstrapToken", 128);
        if (suppliedToken !== bootstrapToken) {
          throw new Error("Invalid development bootstrap capability.");
        }
        if (bootstrapUsed) {
          response.writeHead(409, { "cache-control": "no-store" });
          response.end();
          return;
        }
        bootstrapUsed = true;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({
          buildId,
          extensionId,
          resultToken,
          timeoutMs,
          token,
        }));
      } catch {
        response.writeHead(400, { "cache-control": "no-store" });
        response.end();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/authorize") {
      try {
        if (!bootstrapUsed) {
          response.writeHead(409, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const raw = await readBoundedRequestBody(request, 1_024);
        const authorization = normalizeDevelopmentReloadAuthorization(JSON.parse(raw), {
          buildId,
          resultToken,
        });
        if (!authorization) {
          throw new Error("Invalid development reload authorization.");
        }
        if (reloadAuthorized) {
          response.writeHead(409, { "cache-control": "no-store" });
          response.end();
          return;
        }
        reloadAuthorized = true;
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } catch {
        response.writeHead(400, { "cache-control": "no-store" });
        response.end();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/result") {
      try {
        if (settled) {
          response.writeHead(409, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const raw = await readBoundedRequestBody(request, RESULT_BODY_LIMIT);
        const normalized = normalizeDevelopmentReloadResult(JSON.parse(raw), {
          buildId,
          resultToken,
        });
        if (!normalized) throw new Error("Invalid development reload result.");
        if (normalized.status === "reloaded" && !reloadAuthorized) {
          throw new Error("Reload result was not authorized.");
        }
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        if (!settled) {
          settled = true;
          resolveResult(normalized);
        }
      } catch {
        response.writeHead(400, { "cache-control": "no-store" });
        response.end();
      }
      return;
    }
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  });
  const handleRuntimeError = (error) => {
    if (!settled) {
      settled = true;
      rejectResult(error);
    }
  };
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const handleListenError = (error) => {
        rejectPromise(error);
      };
      server.once("error", handleListenError);
      server.listen(port, CONTROL_HOST, () => {
        server.off("error", handleListenError);
        server.on("error", handleRuntimeError);
        resolvePromise();
      });
    });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    throw new Error(
      `Development reload control port ${port} is unavailable (${code}).`,
      { cause: error },
    );
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    throw new Error("Development reload server did not expose a TCP address.");
  }
  const controlUrl = `http://${CONTROL_HOST}:${address.port}/reload#${bootstrapToken}`;
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      server.closeAllConnections?.();
      if (server.listening) {
        await new Promise((resolvePromise) => server.close(resolvePromise));
      }
    },
    controlUrl,
    result,
    startTimeout: () => {
      if (timer !== undefined || settled || closed) return;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectResult(new Error("Timed out waiting for the Chrome reload helper."));
      }, timeoutMs + 5_000);
    },
  };
}

function normalizeSingleStringField(value, field, maximumLength) {
  const record = readExactDataRecord(value, [field]);
  if (!record || !isBoundedString(record[field], maximumLength)) return null;
  return record[field];
}

function normalizeDevelopmentReloadAuthorization(value, expected) {
  const record = readExactDataRecord(value, [
    "observedBuildId",
    "resultToken",
    "targetBuildId",
  ]);
  if (
    !record ||
    !isBoundedString(record.observedBuildId, 128) ||
    record.resultToken !== expected.resultToken ||
    record.targetBuildId !== expected.buildId ||
    record.observedBuildId === expected.buildId
  ) {
    return null;
  }
  return {
    observedBuildId: record.observedBuildId,
    targetBuildId: record.targetBuildId,
  };
}

function readExactDataRecord(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  return value;
}

async function readBoundedRequestBody(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function openChrome(binding, url) {
  const child = spawn(
    binding.chromePath,
    buildDevelopmentChromeLaunchArguments(binding, url),
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

async function logEvent(event) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  })}\n`, "utf8");
}

function isBoundedString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 32) return null;
  const normalized = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const keys = Reflect.ownKeys(entry);
    if (
      keys.length !== 3 ||
      !keys.includes("at") ||
      !keys.includes("kind") ||
      !keys.includes("message")
    ) {
      return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    }
    if (
      !isBoundedString(entry.at, 64) ||
      !["error", "unhandledrejection"].includes(entry.kind) ||
      !isBoundedString(entry.message, 512)
    ) {
      return null;
    }
    normalized.push({ at: entry.at, kind: entry.kind, message: entry.message });
  }
  return normalized;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await logEvent({ event: "runner_failed", message: message.slice(0, 512) });
    } catch {}
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
