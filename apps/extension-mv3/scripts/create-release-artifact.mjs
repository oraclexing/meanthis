import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseVersionAlignment } from "../../../scripts/version-alignment.mjs";
import { createExtensionReleaseArtifact } from "./extension-release-artifact.mjs";
import {
  extensionProfileOutDir,
  parseExtensionSurfaceProfile,
} from "./extension-surface-profile.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const surfaceProfile = parseExtensionSurfaceProfile(process.argv[2]);
const configuredOutputRoot = process.env.MEANTHIS_EXTENSION_RELEASE_OUTPUT_ROOT;
if (configuredOutputRoot !== undefined
  && (configuredOutputRoot.length === 0 || !isAbsolute(configuredOutputRoot))) {
  throw new Error("Extension release output root must be an absolute path.");
}
const outputRoot = configuredOutputRoot === undefined
  ? join(
      fileURLToPath(new URL("../../../output/extension-mv3/", import.meta.url)),
      surfaceProfile,
    )
  : resolve(configuredOutputRoot);

await verifyReleaseVersionAlignment(root);
const result = await createExtensionReleaseArtifact({
  sourceDirectory: fileURLToPath(new URL(`../${extensionProfileOutDir(surfaceProfile)}/`, import.meta.url)),
  outputRoot,
  rootManifestPath: fileURLToPath(new URL("../../../package.json", import.meta.url)),
  extensionManifestPath: fileURLToPath(new URL("../package.json", import.meta.url)),
  cliManifestPath: fileURLToPath(new URL("../../cli/package.json", import.meta.url)),
  forbiddenPaths: [root],
  surfaceProfile,
});

const display = (path) => relative(root, path).replaceAll("\\", "/");
process.stdout.write(`Extension release archive: ${display(result.archivePath)}\n`);
process.stdout.write(`Extension release manifest: ${display(result.manifestPath)}\n`);
