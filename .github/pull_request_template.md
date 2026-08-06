## Summary

<!-- What user-visible or contributor-visible behavior changes, and why? Keep the scope narrow. -->

## Product boundary

<!--
MeanThis captures, reviews, re-resolves, and serializes UI reference context. It
does not perform downstream browser actions or source edits. Name the affected
surface and explain any boundary or permission impact.
-->

- Affected surface:
- Boundary or permission impact:

## Focused verification

<!-- Include exact commands/manual checks and results. For non-trivial behavior, include the focused RED/GREEN evidence. -->

| Check | Result |
| --- | --- |
|  |  |

## Review checklist

- [ ] The change is narrow, reproducible, and does not include unrelated cleanup.
- [ ] Tests cover non-trivial behavior, or I explained why no test is needed.
- [ ] English and Simplified Chinese public docs are structurally aligned, or no public docs changed.
- [ ] I did not add private page content, raw captures, credentials, tokens, cookies, private source, personal configuration, or absolute machine paths.
- [ ] I reviewed generated artifacts and untracked files before including them.
- [ ] Before final review, I ran `npm test`, `npm run build`, `npm audit --audit-level=moderate`, and `git diff --check`, or documented any check that could not run.

## Remaining risks

<!-- State known gaps, browser/runtime coverage not exercised, and any intentionally deferred work. -->
