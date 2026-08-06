# Releasing MeanThis

English | [中文](./RELEASING_zh.md)

This repository can build local release candidates. None of the commands below publish, sign, upload, tag, or change repository visibility.

## Local gate

From a clean exact commit, using the pinned Node.js and npm versions:

```bash
npm ci
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

`npm run build` compiles the nine public packages, demo, and consumer extension; runs the public examples; and verifies package tarballs in a temporary offline consumer.

`npm run pack:extension` writes an unsigned consumer ZIP and checksum manifest under `output/extension-mv3/consumer/<version>/`. The artifact is a local integrity candidate, not a signature or publisher attestation.

## Repository history

The first public commit is a reviewed, de-identified root that intentionally excludes the private development history. After publication, this repository keeps normal incremental commits and pull requests; do not replace its history with a newly generated root or force-push routine updates.

If a public contribution changes a projection-managed file, the maintainer first imports and reviews that change in the private upstream. The next projection update must stop rather than overwrite an unimported public change. Projection tooling may stage a reviewed tree, but a human still reviews and creates the public commit.

## External owner steps

Before publication, the owner must separately review the exact commit, remote CI, repository settings, npm scope custody and trusted publishing, the public [Privacy Notice](./PRIVACY.md), browser-store disclosures, signing, and fresh installation or upgrade behavior.
