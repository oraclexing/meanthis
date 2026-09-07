import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildDevelopmentChromeLaunchArguments,
  revalidateDevelopmentChromeBinding,
  resolveDevelopmentChromeBinding,
} from "./development-chrome-profile.mjs";

const extensionId = "bbiiccaidhlhdagmabkogleldjdnmlfn";
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function createFixture(profileNames = ["Default"]) {
  const root = await mkdtemp(join(tmpdir(), "meanthis-development-profile-"));
  fixtureRoots.push(root);
  const chromePath = join(root, "chrome.exe");
  const userDataDir = join(root, "User Data");
  const expectedExtensionPath = join(root, "repo", "apps", "extension-mv3", "dist");
  const otherExtensionPath = join(root, "repo", "apps", "extension-mv3", "dist-consumer");
  await writeFile(chromePath, "", "utf8");
  await mkdir(expectedExtensionPath, { recursive: true });
  await mkdir(otherExtensionPath, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "Local State"), JSON.stringify({
    profile: {
      info_cache: Object.fromEntries(profileNames.map((name) => [name, { name }])),
      last_used: profileNames.at(-1),
    },
  }), "utf8");
  for (const name of profileNames) {
    await mkdir(join(userDataDir, name), { recursive: true });
  }
  return { chromePath, expectedExtensionPath, otherExtensionPath, root, userDataDir };
}

async function writeExtensionRecord({
  extensionPath,
  fileName = "Secure Preferences",
  profileDirectory = "Default",
  userDataDir,
}: {
  extensionPath: string;
  fileName?: "Preferences" | "Secure Preferences";
  profileDirectory?: string;
  userDataDir: string;
}) {
  await writeFile(join(userDataDir, profileDirectory, fileName), JSON.stringify({
    extensions: {
      settings: {
        [extensionId]: {
          location: 4,
          path: extensionPath,
        },
      },
    },
  }), "utf8");
}

async function resolveFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Record<string, unknown> = {},
) {
  return resolveDevelopmentChromeBinding({
    chromePath: fixture.chromePath,
    chromeUserDataDir: fixture.userDataDir,
    expectedExtensionPath: fixture.expectedExtensionPath,
    extensionId,
    ...overrides,
  });
}

describe("development Chrome profile binding", () => {
  test("selects the sole info_cache profile whose exact extension record points at dist", async () => {
    const fixture = await createFixture(["Default", "Profile 1"]);
    await writeExtensionRecord({
      extensionPath: fixture.otherExtensionPath,
      profileDirectory: "Default",
      userDataDir: fixture.userDataDir,
    });
    await writeExtensionRecord({
      extensionPath: fixture.expectedExtensionPath,
      profileDirectory: "Profile 1",
      userDataDir: fixture.userDataDir,
    });

    const binding = await resolveFixture(fixture);

    expect(binding.profileDirectory).toBe("Profile 1");
    expect(binding.chromePath).toBe(await realpath(fixture.chromePath));
    expect(binding.chromeUserDataDir).toBe(await realpath(fixture.userDataDir));
    expect(binding.extensionPath).toBe(await realpath(fixture.expectedExtensionPath));
    expect(binding.profileWasExplicit).toBe(false);
  });

  test("never uses Local State last_used and fails closed on zero or multiple exact candidates", async () => {
    const zero = await createFixture(["Default", "Profile 1"]);
    await writeExtensionRecord({
      extensionPath: zero.otherExtensionPath,
      profileDirectory: "Default",
      userDataDir: zero.userDataDir,
    });
    await expect(resolveFixture(zero)).rejects.toMatchObject({
      code: "extension_path_mismatch",
    });

    const multiple = await createFixture(["Default", "Profile 1"]);
    for (const profileDirectory of ["Default", "Profile 1"]) {
      await writeExtensionRecord({
        extensionPath: multiple.expectedExtensionPath,
        profileDirectory,
        userDataDir: multiple.userDataDir,
      });
    }
    await expect(resolveFixture(multiple)).rejects.toMatchObject({
      code: "chrome_profile_ambiguous",
    });
  });

  test("does not let an explicit profile bypass extension-path verification", async () => {
    const fixture = await createFixture(["Default", "Profile 1"]);
    await writeExtensionRecord({
      extensionPath: fixture.otherExtensionPath,
      profileDirectory: "Default",
      userDataDir: fixture.userDataDir,
    });
    await writeExtensionRecord({
      extensionPath: fixture.expectedExtensionPath,
      profileDirectory: "Profile 1",
      userDataDir: fixture.userDataDir,
    });

    await expect(resolveFixture(fixture, {
      chromeProfileDirectory: "Default",
    })).rejects.toMatchObject({ code: "extension_path_mismatch" });
    await expect(resolveFixture(fixture, {
      chromeProfileDirectory: "Profile 1/child",
    })).rejects.toMatchObject({ code: "chrome_profile_not_direct_child" });
    await expect(resolveFixture(fixture, {
      chromeProfileDirectory: "Profile 1\\child",
    })).rejects.toMatchObject({ code: "chrome_profile_not_direct_child" });
  });

  test("fails closed on conflicting or unreadable fixed extension records", async () => {
    const conflict = await createFixture();
    await writeExtensionRecord({
      extensionPath: conflict.expectedExtensionPath,
      userDataDir: conflict.userDataDir,
    });
    await writeExtensionRecord({
      extensionPath: conflict.otherExtensionPath,
      fileName: "Preferences",
      userDataDir: conflict.userDataDir,
    });
    await expect(resolveFixture(conflict)).rejects.toMatchObject({
      code: "extension_record_conflict",
    });

    const unreadable = await createFixture();
    await writeExtensionRecord({
      extensionPath: unreadable.expectedExtensionPath,
      userDataDir: unreadable.userDataDir,
    });
    await writeFile(join(unreadable.userDataDir, "Default", "Preferences"), "{", "utf8");
    await expect(resolveFixture(unreadable)).rejects.toMatchObject({
      code: "extension_record_unreadable",
    });

    const unreadablePath = await createFixture();
    await writeExtensionRecord({
      extensionPath: join(unreadablePath.root, "missing-dist"),
      userDataDir: unreadablePath.userDataDir,
    });
    await expect(resolveFixture(unreadablePath)).rejects.toMatchObject({
      code: "extension_path_unreadable",
    });
  });

  test("revalidates the same binding and detects post-build profile drift", async () => {
    const fixture = await createFixture();
    await writeExtensionRecord({
      extensionPath: fixture.expectedExtensionPath,
      userDataDir: fixture.userDataDir,
    });
    const binding = await resolveFixture(fixture);

    await expect(revalidateDevelopmentChromeBinding(binding, {
      expectedExtensionPath: fixture.expectedExtensionPath,
      extensionId,
    })).resolves.toEqual(binding);

    await writeExtensionRecord({
      extensionPath: fixture.otherExtensionPath,
      userDataDir: fixture.userDataDir,
    });
    await expect(revalidateDevelopmentChromeBinding(binding, {
      expectedExtensionPath: fixture.expectedExtensionPath,
      extensionId,
    })).rejects.toMatchObject({ code: "extension_path_mismatch" });
  });

  test("launches both helper and extensions pages in the exact resolved profile", async () => {
    const fixture = await createFixture();
    await writeExtensionRecord({
      extensionPath: fixture.expectedExtensionPath,
      userDataDir: fixture.userDataDir,
    });
    const binding = await resolveFixture(fixture);

    expect(buildDevelopmentChromeLaunchArguments(binding, "http://127.0.0.1:41731/reload"))
      .toEqual([
        `--user-data-dir=${binding.chromeUserDataDir}`,
        "--profile-directory=Default",
        "--new-tab",
        "http://127.0.0.1:41731/reload",
      ]);
    expect(buildDevelopmentChromeLaunchArguments(
      binding,
      `chrome://extensions/?id=${extensionId}`,
    )).toEqual([
      `--user-data-dir=${binding.chromeUserDataDir}`,
      "--profile-directory=Default",
      "--new-tab",
      `chrome://extensions/?id=${extensionId}`,
    ]);
  });
});
