import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

const PROFILE_PREFERENCE_FILES = ["Secure Preferences", "Preferences"];

export class DevelopmentChromeProfileError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "DevelopmentChromeProfileError";
  }
}

export async function resolveDevelopmentChromeBinding({
  chromePath,
  chromeProfileDirectory,
  chromeUserDataDir,
  env = process.env,
  expectedExtensionPath,
  extensionId,
}) {
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
    fail("extension_record_unreadable", "The fixed extension ID is malformed.");
  }
  const expectedPath = await canonicalExistingDirectory(
    expectedExtensionPath,
    "expected_extension_path_unreadable",
    "The development extension dist directory is unavailable.",
  );
  const resolvedChromePath = await resolveChromeExecutable(chromePath, env);
  const resolvedUserDataDir = await resolveChromeUserDataDirectory(chromeUserDataDir, env);
  const profileNames = await readProfileNames(resolvedUserDataDir);
  const explicitProfile = chromeProfileDirectory !== undefined;
  let candidates = profileNames;
  if (explicitProfile) {
    assertDirectChildName(chromeProfileDirectory);
    if (!profileNames.includes(chromeProfileDirectory)) {
      fail(
        "chrome_profile_not_found",
        `Chrome profile ${JSON.stringify(chromeProfileDirectory)} is not present in Local State info_cache.`,
      );
    }
    candidates = [chromeProfileDirectory];
  }

  const matches = [];
  let sawExtensionRecord = false;
  let sawPathMismatch = false;
  for (const profileDirectory of candidates) {
    const profilePath = await resolveDirectProfilePath(resolvedUserDataDir, profileDirectory);
    const record = await readExactExtensionRecord(profilePath, extensionId);
    if (record === null) continue;
    sawExtensionRecord = true;
    if (record.path === null || !isAbsolute(record.path)) {
      sawPathMismatch = true;
      continue;
    }
    const extensionPath = await canonicalExistingDirectory(
      record.path,
      "extension_path_unreadable",
      `The fixed extension record in Chrome profile ${JSON.stringify(profileDirectory)} has an unreadable path.`,
    );
    if (!sameCanonicalPath(extensionPath, expectedPath)) {
      sawPathMismatch = true;
      continue;
    }
    matches.push({ extensionPath, profileDirectory, profilePath });
  }

  if (matches.length > 1) {
    fail(
      "chrome_profile_ambiguous",
      "More than one Local State profile has the fixed MeanThis extension record bound to the development dist directory.",
    );
  }
  if (matches.length === 0) {
    if (sawPathMismatch || sawExtensionRecord) {
      fail(
        "extension_path_mismatch",
        "No selected Chrome profile binds the fixed MeanThis extension ID to apps/extension-mv3/dist.",
      );
    }
    fail(
      "extension_record_not_found",
      "No selected Chrome profile contains the fixed MeanThis extension record.",
    );
  }

  return Object.freeze({
    chromePath: resolvedChromePath,
    chromeUserDataDir: resolvedUserDataDir,
    extensionPath: matches[0].extensionPath,
    profileDirectory: matches[0].profileDirectory,
    profilePath: matches[0].profilePath,
    profileWasExplicit: explicitProfile,
  });
}

export async function revalidateDevelopmentChromeBinding(binding, {
  expectedExtensionPath,
  extensionId,
}) {
  assertBindingShape(binding);
  const current = await resolveDevelopmentChromeBinding({
    chromePath: binding.chromePath,
    chromeProfileDirectory: binding.profileWasExplicit
      ? binding.profileDirectory
      : undefined,
    chromeUserDataDir: binding.chromeUserDataDir,
    expectedExtensionPath,
    extensionId,
  });
  if (
    !sameCanonicalPath(current.chromePath, binding.chromePath) ||
    !sameCanonicalPath(current.chromeUserDataDir, binding.chromeUserDataDir) ||
    current.profileDirectory !== binding.profileDirectory ||
    !sameCanonicalPath(current.profilePath, binding.profilePath) ||
    !sameCanonicalPath(current.extensionPath, binding.extensionPath)
  ) {
    fail(
      "chrome_profile_binding_changed",
      "The resolved Chrome development profile binding changed after the extension build.",
    );
  }
  return binding;
}

export function buildDevelopmentChromeLaunchArguments(binding, url) {
  assertBindingShape(binding);
  if (typeof url !== "string" || url.length === 0) {
    fail("chrome_launch_invalid", "Chrome launch requires a non-empty URL.");
  }
  return [
    `--user-data-dir=${binding.chromeUserDataDir}`,
    `--profile-directory=${binding.profileDirectory}`,
    "--new-tab",
    url,
  ];
}

async function resolveChromeExecutable(explicitPath, env) {
  const candidates = explicitPath === undefined
    ? [
        env.MEANTHIS_CHROME_PATH,
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
        env.ProgramFiles && join(env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
        env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
      ].filter((candidate) => typeof candidate === "string" && candidate.length > 0)
    : [explicitPath];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const value = await stat(canonical);
      await access(canonical, constants.R_OK);
      if (value.isFile()) return canonical;
    } catch (error) {
      if (explicitPath !== undefined) {
        fail(
          "chrome_executable_unreadable",
          `The explicit Chrome executable is unavailable (${safeErrorCode(error)}).`,
        );
      }
    }
  }
  fail(
    "chrome_executable_unreadable",
    "Chrome was not found. Pass --chrome-path or set MEANTHIS_CHROME_PATH.",
  );
}

async function resolveChromeUserDataDirectory(explicitPath, env) {
  const candidate = explicitPath ?? (
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google/Chrome/User Data")
  );
  if (typeof candidate !== "string" || candidate.length === 0) {
    fail(
      "chrome_user_data_unreadable",
      "Chrome User Data was not found. Pass --chrome-user-data-dir.",
    );
  }
  return canonicalExistingDirectory(
    candidate,
    "chrome_user_data_unreadable",
    "The Chrome User Data directory is unavailable.",
  );
}

async function readProfileNames(userDataDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8"));
  } catch (error) {
    fail(
      "chrome_local_state_unreadable",
      `Chrome Local State could not be read (${safeErrorCode(error)}).`,
    );
  }
  const infoCache = parsed?.profile?.info_cache;
  if (infoCache === null || typeof infoCache !== "object" || Array.isArray(infoCache)) {
    fail("chrome_local_state_unreadable", "Chrome Local State info_cache is malformed.");
  }
  const profileNames = Object.keys(infoCache);
  if (profileNames.length === 0) {
    fail("chrome_profile_not_found", "Chrome Local State info_cache contains no profiles.");
  }
  for (const profileName of profileNames) assertDirectChildName(profileName);
  return profileNames;
}

async function resolveDirectProfilePath(userDataDir, profileDirectory) {
  assertDirectChildName(profileDirectory);
  const lexicalPath = resolve(userDataDir, profileDirectory);
  const profilePath = await canonicalExistingDirectory(
    lexicalPath,
    "chrome_profile_unreadable",
    `Chrome profile ${JSON.stringify(profileDirectory)} is unavailable.`,
  );
  if (!sameCanonicalPath(dirname(profilePath), userDataDir)) {
    fail(
      "chrome_profile_not_direct_child",
      `Chrome profile ${JSON.stringify(profileDirectory)} is not a direct child of User Data.`,
    );
  }
  return profilePath;
}

async function readExactExtensionRecord(profilePath, extensionId) {
  const records = [];
  for (const fileName of PROFILE_PREFERENCE_FILES) {
    const preferencePath = join(profilePath, fileName);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(preferencePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail(
        "extension_record_unreadable",
        `${fileName} could not be read for the selected Chrome profile (${safeErrorCode(error)}).`,
      );
    }
    const settings = parsed?.extensions?.settings;
    if (settings === undefined) continue;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      fail("extension_record_unreadable", `${fileName} extensions.settings is malformed.`);
    }
    if (!Object.hasOwn(settings, extensionId)) continue;
    const record = settings[extensionId];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("extension_record_unreadable", `${fileName} has a malformed fixed extension record.`);
    }
    records.push({
      fileName,
      path: typeof record.path === "string" && record.path.length > 0
        ? record.path
        : null,
    });
  }
  if (records.length === 0) return null;
  if (records.length === 2) {
    if (
      records[0].path === null ||
      records[1].path === null ||
      !isAbsolute(records[0].path) ||
      !isAbsolute(records[1].path)
    ) {
      fail(
        "extension_record_conflict",
        "Secure Preferences and Preferences disagree for the fixed MeanThis extension record.",
      );
    }
    const canonicalPaths = await Promise.all(records.map((record) => (
      canonicalExistingDirectory(
        record.path,
        "extension_path_unreadable",
        `${record.fileName} has an unreadable fixed MeanThis extension path.`,
      )
    )));
    if (!sameCanonicalPath(canonicalPaths[0], canonicalPaths[1])) {
      fail(
        "extension_record_conflict",
        "Secure Preferences and Preferences disagree for the fixed MeanThis extension record.",
      );
    }
    return { path: canonicalPaths[0] };
  }
  return { path: records[0].path };
}

async function canonicalExistingDirectory(path, code, message) {
  if (typeof path !== "string" || path.length === 0) fail(code, message);
  try {
    const canonical = await realpath(path);
    const value = await stat(canonical);
    await access(canonical, constants.R_OK);
    if (!value.isDirectory()) throw new Error("not_a_directory");
    return canonical;
  } catch (error) {
    fail(code, `${message} (${safeErrorCode(error)})`);
  }
}

function assertDirectChildName(profileDirectory) {
  if (
    typeof profileDirectory !== "string" ||
    profileDirectory.length === 0 ||
    profileDirectory === "." ||
    profileDirectory === ".." ||
    profileDirectory.includes("/") ||
    profileDirectory.includes("\\") ||
    basename(profileDirectory) !== profileDirectory
  ) {
    fail(
      "chrome_profile_not_direct_child",
      "--chrome-profile-directory must name one direct User Data child.",
    );
  }
}

function assertBindingShape(binding) {
  if (
    binding === null ||
    typeof binding !== "object" ||
    typeof binding.chromePath !== "string" ||
    typeof binding.chromeUserDataDir !== "string" ||
    typeof binding.extensionPath !== "string" ||
    typeof binding.profileDirectory !== "string" ||
    typeof binding.profilePath !== "string" ||
    typeof binding.profileWasExplicit !== "boolean"
  ) {
    fail("chrome_profile_binding_invalid", "Chrome development profile binding is malformed.");
  }
  assertDirectChildName(binding.profileDirectory);
}

function sameCanonicalPath(left, right) {
  return pathKey(left) === pathKey(right);
}

function pathKey(value) {
  const normalized = normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function safeErrorCode(error) {
  return typeof error?.code === "string" ? error.code : "invalid_data";
}

function fail(code, message) {
  throw new DevelopmentChromeProfileError(code, message);
}
