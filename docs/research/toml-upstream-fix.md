# Independent upstream TOML result correction

Experimental fix, 2026-11-11. Komodo base:
`161bc0d01af881118d14ca85c838e524284c76dd` (upstream 1.5.1).
Branch: `experiment/fix-toml-result-bytes-upstream-1.5.1`.
Framework base: `706db031cc19c0ec246c078c216e904343690b67` (1.3.0).
Integration review reference: `8e3c538971eff15d6b5c5ee1b78ac95622154ddc`.
Neither the adaptive-response feature nor its integration code is included.

## Independent reproduction

`src/tools/toml.test.ts` starts the real upstream server over stdio against a
loopback Komodo fixture with synthetic data and credentials. It calls both
`komodo_toml_export_all` and `komodo_toml_export_resources`, using only the existing
`inline_full=true/false` option. It verifies rendered and structured inline
content, resources/read, TOML parsing, UTF-8 byte counts, structural secret masking
and unchanged behavior when redaction is explicitly disabled. No writes or real
Komodo services are used.

Run `npm test`. To test another compiled server with the same assertions:

```sh
KOMODO_TOML_TEST_ENTRY=/path/to/upstream/build/index.js node --test build-test/tools/toml.test.js
```

| Komodo production source | Installed framework | Result |
| --- | --- | --- |
| unmodified 1.5.1 | exact 1.3.0 source | 4 enabled-redaction leaf cases fail; raw opt-out cases pass |
| unmodified 1.5.1 | isolated framework fix | inline cases pass; 2 linked leaf cases fail on size |
| this branch | isolated framework fix | 11 tests pass, 0 fail (includes parent tests) |

In the first row, inline TOML is invalid and linked output disagrees with inline.
The second row independently identifies the size defect after serialization is
repaired. Disabled redaction is a compatibility test, not the proposed fix.

## Ownership and proposed changes

The framework's central result scrubber applies flat-text regexes to the TOML
string after the tool has structurally redacted and serialized it. A value such
as `password=\"**********\"` inside a TOML string is split at the escaped quote;
the regex replaces the backslash and leaves an invalid quote sequence. Rendered
text passes through the same problem. This belongs in the shared framework
scrubber used by the result boundary, not a Komodo opt-out or ad hoc unescape.

The isolated framework branch `experiment/fix-result-scrubbing-1.3.0` scrubs
quoted values before their serialized container, retaining container key rules,
structural rules, literal purging and generic withholding on failure. It supplies
its own regression tests and review notes. Its exact commit is recorded in the
delivery report. It remains local because framework upstream is read-only and
there is no writable framework fork. Patch/bundle artifacts accompany delivery.

Komodo independently calculates linked `summary.bytes` from the raw API response.
Resource registration can redact secrets, remove fields and normalize formatting,
so that number is wrong. This branch reads the registered session-bound content
and counts its actual bytes. The inline summary already counts the redacted
string and becomes accurate once the framework stops corrupting it. Reading the
registry does not bypass scrubbing, change TTL/session checks or disable any
central redaction. Tests cover both tools and both response forms, including
multibyte text. The parser is declared as a test-only dependency at the version
already present in the lockfile.

## Validation prerequisites and recommendation

Validation uses Node 24.22.1/npm 11.9.0. The exact upstream npm framework 1.3.0
archive returns HTTP 404. Tests therefore use a local build of the pinned source,
then a local build of the isolated correction in this checkout's node_modules.
No framework source, local path/archive, Git dependency, permanent fork, or
redaction bypass is committed to Komodo. The manifest still targets `~1.3.0`.
This is source-snapshot validation, not certification of a future registry build.

Build, production build, typecheck, lint, formatting and diff checks pass.
The advertised upstream e2e script references an absent
`__tests__/e2e/auth.e2e.mjs`; no claim is made for that unavailable suite. These
new stdio tests supply the targeted regression reproduction.

Recommend a framework fix/release first, followed by the independently reviewable
Komodo byte-count correction and these regression tests against that published
artifact. A future dependency bump may be needed once upstream chooses a release;
do not point Komodo at a private framework fork. Keep both submissions separate
from category filtering and PR #242. No upstream PR, merge, deployment or
production infrastructure change was performed.
