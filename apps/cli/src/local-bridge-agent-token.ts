import { randomBytes as secureRandomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TOKEN_PATTERN = /^([A-Za-z0-9_-]{43})(?:\r?\n)?$/;

export interface LocalBridgeAgentTokenOptions {
  codexHome?: string;
  randomBytes?: (size: number) => Uint8Array;
}

export function getLocalBridgeAgentTokenPath(codexHome = resolveCodexHome()): string {
  return join(codexHome, "ui-attach", "bridge-agent-key-v2");
}

export async function loadOrCreateLocalBridgeAgentToken(
  options: LocalBridgeAgentTokenOptions = {},
): Promise<string> {
  const codexHome = options.codexHome ? resolve(options.codexHome) : resolveCodexHome();
  const directory = join(codexHome, "ui-attach");
  const path = getLocalBridgeAgentTokenPath(codexHome);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    return await readCredential(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const randomBytes = options.randomBytes ?? ((size: number) => secureRandomBytes(size));
  const token = Buffer.from(randomBytes(32)).toString("base64url");
  if (!TOKEN_PATTERN.test(token)) throw new Error("Generated local bridge credential is invalid.");
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return readCredential(path);
  }
  await chmod(path, 0o600);
  return token;
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
}

async function readCredential(path: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Existing local bridge credential is invalid.");
  }
  const raw = await readFile(path, "utf8");
  const match = TOKEN_PATTERN.exec(raw);
  if (!match) throw new Error("Existing local bridge credential is invalid.");
  await chmod(path, 0o600);
  return match[1];
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
