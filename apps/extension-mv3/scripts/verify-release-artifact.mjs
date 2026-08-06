import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExtensionReleaseArtifact,
  EXTENSION_RELEASE_FILES,
  extractExtensionReleaseArtifact,
} from "./extension-release-artifact.mjs";
import {
  extensionProfileOutDir,
  parseExtensionSurfaceProfile,
} from "./extension-surface-profile.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const surfaceProfile = parseExtensionSurfaceProfile(process.argv[2]);
const temporaryRoot = await mkdtemp(join(tmpdir(), "ui-attach-extension-release-verify-"));
const baseOptions = {
  sourceDirectory: fileURLToPath(new URL(`../${extensionProfileOutDir(surfaceProfile)}/`, import.meta.url)),
  rootManifestPath: fileURLToPath(new URL("../../../package.json", import.meta.url)),
  extensionManifestPath: fileURLToPath(new URL("../package.json", import.meta.url)),
  cliManifestPath: fileURLToPath(new URL("../../cli/package.json", import.meta.url)),
  forbiddenPaths: [root],
  surfaceProfile,
};

try {
  const first = await createExtensionReleaseArtifact({
    ...baseOptions,
    outputRoot: join(temporaryRoot, "first"),
  });
  const second = await createExtensionReleaseArtifact({
    ...baseOptions,
    outputRoot: join(temporaryRoot, "second"),
  });
  const [firstArchive, secondArchive, firstManifest, secondManifest] = await Promise.all([
    readFile(first.archivePath),
    readFile(second.archivePath),
    readFile(first.manifestPath),
    readFile(second.manifestPath),
  ]);
  if (!firstArchive.equals(secondArchive) || !firstManifest.equals(secondManifest)) {
    throw new Error("Extension release artifact is not deterministic.");
  }
  const extracted = await extractExtensionReleaseArtifact({
    archivePath: first.archivePath,
    manifestPath: first.manifestPath,
    targetDirectory: join(temporaryRoot, "extracted"),
  });
  if (JSON.stringify(extracted.files) !== JSON.stringify(EXTENSION_RELEASE_FILES)) {
    throw new Error("Extension release extraction file set is invalid.");
  }
  process.stdout.write("Extension release artifact verified.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
