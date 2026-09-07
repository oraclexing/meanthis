# Releasing MeanThis

English | [中文](./RELEASING_zh.md)

This repository can build local release candidates. None of the commands below publish, sign, upload, tag, or change repository visibility.

## Local gate

From a clean exact commit, using the supported Node.js release line and exact npm version:

```bash
npm ci
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

`npm run build` compiles the nine public packages, demo, and consumer extension; runs the public examples; and verifies package tarballs in a temporary cache-preferred consumer. That consumer uses `--prefer-offline`, so a cold cache may still make npm access the configured registry.

`npm run pack:extension` writes an unsigned consumer ZIP and checksum manifest under `output/extension-mv3/consumer/<version>/`. The artifact is a local integrity candidate, not a signature or publisher attestation.

## Draft GitHub Release

The public repository contains a tag-only workflow for exact `vX.Y.Z` tags. It requires the tag version to match every public package and browser manifest, requires the tagged commit to be on `origin/main`, reruns the local gate, and stages exactly three assets:

```text
meanthis-extension-mv3-<version>.zip
meanthis-extension-mv3-<version>.manifest.json
meanthis-extension-mv3-<version>.sha256
```

The checksum file binds both the ZIP and manifest. The workflow creates a **draft** GitHub Release, verifies that it is still a draft and that the remote asset names are exact, and never publishes the draft. It also never creates a tag: the owner creates and pushes the reviewed tag separately after approving the exact commit.

A GitHub Release gives users a no-build download, but Chrome still requires extraction and **Load unpacked** in Developer mode. A signed Chrome Web Store listing is the separate one-click installation path.

npm publication is also separate. The MCP server is host-neutral; npm makes the CLI executable easier to install but does not change its protocol or grant any Host integration authority.

## Repository history

The first public commit is a reviewed, de-identified root that intentionally excludes the private development history. After publication, this repository keeps normal incremental commits and pull requests; do not replace its history with a newly generated root or force-push routine updates.

If a public contribution changes a projection-managed file, the maintainer first imports and reviews that change in the private upstream. The next projection update must stop rather than overwrite an unimported public change. Projection tooling may stage a reviewed tree, but a human still reviews and creates the public commit.

## External owner steps

Before publication, the owner must separately review the exact commit, remote CI, repository settings, npm scope custody and trusted publishing, the draft Release and all three assets, the public [Privacy Notice](./PRIVACY.md), browser-store disclosures, signing, and fresh installation or upgrade behavior. Publishing a draft Release, publishing npm packages, submitting to the Chrome Web Store, and changing repository visibility remain distinct owner actions.
