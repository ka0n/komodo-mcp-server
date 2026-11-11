# Reject unknown tool categories at startup

Experimental independent upstream fix, 2026-11-11. Base:
`MP-Tool/komodo-mcp-server@161bc0d01af881118d14ca85c838e524284c76dd` (1.5.1).
Reference review: `8e3c538971eff15d6b5c5ee1b78ac95622154ddc`.
Branch: `experiment/fix-invalid-category-upstream-1.5.1`.

## Reproduction and cause

On the unmodified upstream server, tools/list over stdio returned:

| MCP_TOOLS_ALLOWED_CATEGORIES | Tool count | stack_delete exposed |
| --- | ---: | --- |
| unset | 88 | yes |
| typo | 88 | yes |
| stack,typo | 5 | yes |
| stack | 5 | yes |

`validateCategories` warned, deleted unknown names and returned a set. An
invalid-only allowlist therefore became the empty set, which the registration
filter deliberately treats as unrestricted. A mixed list silently accepted the
valid subset. This is operator filtering failure, not a scope-check bypass.

## Proposed correction

Replace warning-and-deletion with `ConfigurationError.invalidEnvVar` before
registration. Reject unknown values in both allowlists and category exclusions,
including mixed lists and file-backed settings; list valid choices in the startup
error. Keep empty/unset lists, CSV trimming, valid filters, individual tool
exclusions, authentication and scope checks unchanged. No framework change or
adaptive-response code is included.

## Automated verification

`src/server.test.ts` is tracked outside upstream's ignored local-test directory.
Run with supported Node and dependencies installed:

```sh
npm test
npm run build
npm run build:prod
npm run typecheck
npm run lint
npm run format:check
```

The suite covers invalid-only and mixed category names for both settings through
environment and config-file inputs, unset/empty/whitespace lists, category and
individual-tool exclusions, uncallability of removed tools, and denial of a retained
delete tool to a read-only scope. No downstream service is contacted.

To run the identical regression assertions against a separately built baseline:

```sh
KOMODO_CATEGORY_TEST_ENTRY=/path/to/upstream/build/index.js node --test build-test/server.test.js
```

Validation uses Node 24.22.1/npm 11.9.0 and the exact framework 1.3.0 source
`706db031cc19c0ec246c078c216e904343690b67`, built and packed locally. The
locked npm framework tarball currently returns HTTP 404. Only a disposable
installation's resolved archive path was substituted; the committed manifest and
lockfile have no framework changes. This does not certify a future npm artifact.

Final suite: **15 passed, 0 failed**. Baseline: the eight invalid-setting
assertions fail because upstream starts; the positive cases pass
(node:test also counts their parent tests). Builds, typecheck,
lint, formatting and diff whitespace checks pass. Exact SHAs and command results
are recorded in the delivery report.

## Submission recommendation

Submit as a small independent Komodo fix after review, targeting the 1.5.1 line.
It can be reviewed independently of the TOML/framework work and PR #242. Call out
the intentional startup behavior change for operators with misspelled category
settings. Resolve the upstream framework publication prerequisite before relying
on a clean registry-only CI install. No PR, merge, deployment or production change
was performed.
