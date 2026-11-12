# Komodo 1.5.1 inline-response hardening

Evaluation date: 2026-11-12. Repository: `ka0n/komodo-mcp-server`.
Branch: `experiment/komodo-1.5.1-inline-hardening`.

## Decision

**Reviewable experiment; not production ready.** A narrow TOML rejection guard
prevents the reproduced inline serialization corruption without bypassing central
redaction. It does not repair the framework's text heuristics. Further investigation
confirmed inherited credential disclosure in nested quoted environment strings,
including linked TOML, JSON configuration and plain logs. The adversarial security
reproduction deliberately exits nonzero. Passing integration tests do not override it.

No deployment, production connection, PR creation/update, merge, force-push, SDK v2
migration, dependency update, permanent framework fork, or global SecretScrubber
change was made. The rejected B1 patch was not applied. Category PR #251 remains separate.

## Sources and dependency reproducibility

| Input                       | Verified identity/status                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting integration branch | `8e3c538971eff15d6b5c5ee1b78ac95622154ddc`, exact local base and remote head                                                                                                                                                                                                  |
| Upstream 1.5.1              | `161bc0d01af881118d14ca85c838e524284c76dd`, ancestor of the integration; upstream `1.5.1` still points here                                                                                                                                                                   |
| Framework 1.3.0             | `706db031cc19c0ec246c078c216e904343690b67`, upstream `1.3.0` still points here                                                                                                                                                                                                |
| Rejected framework patch    | `7c808d790927412b769f7cd444b5b0ccb9ca3a54`, fetched/inspected, descends from framework base; not applied                                                                                                                                                                      |
| Prior security evaluation   | `90fbe0b68bdfbb7b6f0cef9951792686878b4892`: **not verifiable** in the supplied repositories. Git reports “not our ref”; GitHub commit queries to the fork and framework fork return 422. No conclusions from an unavailable report are represented as independently verified. |
| PR #242                     | Open; head `41c1fe40b3388c5c1957788d758455f8457a3c80`, base `main` / 1.5.0; unchanged                                                                                                                                                                                         |
| PR #251                     | Open; head `a6c6d0ff344fa0829697783f55bf401e1f178412`, base exact 1.5.1; unchanged                                                                                                                                                                                            |

Production correction commit: `df0e5cd29ce2db3713a5f3a98a3002aa1cea0fe8`.
Regression/harness commit: `84ba433dc7ff79bdc21213c085094a39a68c5bc9`.
The final documentation commit follows them on the branch.

Node **24.22.1**, npm **11.9.0** were used. The environment's initial Node 24.19.0
does not satisfy the repository engine (`^22.23.4 || ^24.22.1 || >=26.12.1`).
Manifest and lockfile are unchanged from the integration base.

| Package                   | Manifest requirement | Exact installed/locked version        |
| ------------------------- | -------------------- | ------------------------------------- |
| komodo_client             | `^2.3.1`             | 2.3.2                                 |
| mcp-server-framework      | `~1.3.0`             | 1.3.0, source-built substitution only |
| smol-toml                 | `1.9.1`              | 1.9.1                                 |
| @modelcontextprotocol/sdk | `^1.32.2`            | 1.32.2                                |
| zod                       | transitive           | 4.6.7                                 |
| typescript                | `^5.9.3`             | 5.9.3                                 |
| @hono/node-server         | transitive           | 2.1.5                                 |

npm still reports Komodo 1.5.0 and Framework 1.2.0 as latest. Exact-version metadata
queries for Komodo 1.5.1 and Framework 1.3.0 both return 404. No 1.5.1 tag was
returned by the upstream tag probe. The exact locked framework 1.3.0 tarball still
returns HTTP 404. An unchanged `npm ci` was attempted in a disposable checkout and
failed for that URL. This is a publication blocker, not an implementation failure.

Following the existing integration report, framework source was checked out at
the exact SHA, installed from its own lockfile, built and packed. Only in `/tmp`
was the application lock entry's `resolved` URL temporarily changed to the archive.
The original lockfile was restored immediately after installation. Baseline,
upstream and final checks use that same installed dependency graph. No dependencies
or generated builds were installed in the review checkout.

Observed SHA-256 values:

```text
package.json       e181f744534cae075972625028cf156bf65f216c8b43fa355900cb6fa9ad39b8
package-lock.json  f281bcbe1c1fa64a0cd9ed13d0aa0e5531551228be46fde713134270bfbc3437
source-built tgz   65607392df09f568e90c6c61bfa76b6c35c4dccc41300dc2ec3c28a03be23e56
```

To replay, put supported Node/npm on PATH, then run from this repository:

```sh
SOURCE_FRAMEWORK=1 bash docs/research/inline-hardening-validate.sh HEAD
```

The script archives the requested ref into a fresh `/tmp` directory, enforces
package engines, first attempts the exact published install, and permits the
documented fallback only for the framework tarball 404. It retains evidence and
reports command failures. Its nonzero exit is currently expected for the missing
upstream e2e entrypoint, disclosure reproduction and category fail-open reproduction. Without `SOURCE_FRAMEWORK=1`
it stops on the publication blocker. The script was syntax-checked; its constituent
commands were executed during this evaluation. A future published tarball must be
reviewed and tested independently; source substitution does not certify that artifact.

For baseline comparisons, archive `8e3c538971eff15d6b5c5ee1b78ac95622154ddc`, copy the
benchmark/reproduction scripts into its `docs/research`, build, and run them with
the same dependencies. The portable reproduction also runs against the exact
upstream 1.5.1 archive. All credentials and API fixtures are synthetic.

## Complete adaptive tool inventory

There are **22** adaptive tools. All require `komodo:read`. Delivery changes neither
their input/output schemas nor authorization. Names below use literal brace
expansion to list tool families; each member was exercised through SDK output-schema
validation in the tracked tests.

| Tools                                                                                                        | Source and structuredContent                                                                                                               | Linked MIME/category          | Rendered representation / payload characteristics                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `komodo_{action,alerter,build,builder,deployment,procedure,repo,resource_sync,server,stack,swarm}_info` (11) | Komodo resource object; per-resource `*InfoOutputSchema`, `summary` plus `info` or `resourceLink`                                          | `application/json`, `info`    | Summary/link or full fenced JSON; **JSON rendering is not bounded**. Stack/deployment configuration can contain Compose/Docker content and environment strings. No local absolute byte cap.  |
| `komodo_update_info`                                                                                         | Komodo Update object; `updateInfoOutputSchema`, `summary` plus `info` or link                                                              | `application/json`, `info`    | Operation summary plus full JSON; includes per-stage logs; no absolute cap. Permission target is checked after fetching the Update.                                                          |
| `komodo_container_inspect`                                                                                   | Docker inspect object; `containerInspectOutputSchema`, `summary`, `inspect` or link                                                        | `application/json`, `inspect` | Summary plus JSON or link; env/labels may contain secrets; no byte cap.                                                                                                                      |
| `komodo_docker_{image,network,volume}_inspect` (3)                                                           | Docker inspect object; `imageInspectOutputSchema`, `networkInspectOutputSchema`, `volumeInspectOutputSchema`; `summary`, `inspect` or link | `application/json`, `inspect` | Summary plus JSON or link; unbounded object/config/layer/label data.                                                                                                                         |
| `komodo_docker_image_history`                                                                                | Layer array mapped into `items`; `imageHistoryOutputSchema`                                                                                | `application/json`, `inspect` | Layer listing or link; link payload retains `items: []` and summary; no byte cap.                                                                                                            |
| `komodo_container_logs`                                                                                      | stdout/stderr strings; `containerLogsOutputSchema`, `summary`, optional streams or link                                                    | `text/plain`, `logs`          | Labelled combined streams in resource; separate structured inline streams. Text preview truncates each stream at the 4,000-character renderer budget. Positive tail count is not a byte cap. |
| `komodo_container_search_logs`                                                                               | Filtered log matches; `containerSearchLogsOutputSchema`, summary/counts, `matches` or link                                                 | `text/plain`, `logs`          | Joined stream-prefixed matched lines; rendered preview bounded to 4,000 characters. Full structured matches retained inline.                                                                 |
| `komodo_build_logs`                                                                                          | Update/per-stage Log array; `buildLogsOutputSchema`, summary/update/status/success and logs or link                                        | `text/plain`, `logs`          | Joined stage/command/stdout/stderr resource; per-stage rendered stream previews bounded individually, so total text scales with stages. Full structured logs retained inline.                |
| `komodo_toml_export_{all,resources}` (2)                                                                     | TOML string; `tomlOutputSchema`, `summary.bytes`, `summary.secrets_masked`, `toml` or link                                                 | `application/toml`, `info`    | Link or fenced TOML. Exports over 4,000 characters get a bounded preview and point to complete `structuredContent.toml`. No absolute export cap.                                             |

ResourceSync **info** participates in adaptive delivery. ResourceSync **run/refresh**
does not: run confirms, executes and polls; refresh writes pending-preview state and
returns the upstream action schema. Container list/stats and other list/action tools
also do not use this helper. There is no independent Compose export delivery path;
Compose source lives in resource configuration and TOML exports. A source inventory
of every `tryRegisterResource`/`buildInfoResult` call found no additional adaptive tools.

### Scrubbing and storage stages

- Inline JSON/logs: raw handler data and rendered text enter the framework tool
  boundary. `scrubStructured` applies key/path/sibling/drop rules and text heuristics;
  rendered blocks get generic text scrubbing plus purging of collected literals.
- Links: JSON serialization/log joining is lazy. The registry scrubs on register
  using the MIME adapter: JSON/TOML are parsed, structurally scrubbed, serialized;
  plain logs use generic text scrubbing. Summary/link metadata still passes the
  tool boundary. `resources/read` verifies ownership/expiry and independently applies
  MIME scrubbing using the registered resource MIME. Reads bypass the tool boundary.
- TOML adds local strict parse → policy scrub → serialize → parse before either
  path. Parse/serializer/scrub failures are withheld without their causes or export
  data being logged. The new inline guard checks the already-redacted payload and
  rendered text using the same policy before the unchanged central boundary runs.
- Ephemeral URIs bind to session, not just an authenticated username. Framework 1.3
  supplies stdio session IDs. Default TTL is 15 minutes for info/inspect/TOML,
  2 minutes for logs; default capacity is 1,000 entries, with oldest-entry eviction.
  Entry limits are not a total memory/byte budget.

### Delivery-mode matrix

| Condition                       | JSON/logs and stable TOML                                                                     | Unstable inline TOML, redaction enabled                     |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `link`, valid session           | Register full resource, return summary/link                                                   | Link still attempted; strict structural processing retained |
| `inline`                        | Complete structured inline payload, no registration                                           | Explicit `isError`, no TOML structured content              |
| `auto`, bytes ≤ threshold       | Inline (inclusive default 16,384 UTF-8 bytes)                                                 | Explicit error                                              |
| `auto`, bytes > threshold       | Link                                                                                          | Link attempted                                              |
| `inline_full=true` in any mode  | Inline override retained                                                                      | Explicit error rather than corrupt success                  |
| Missing/empty session ID        | Complete inline fallback                                                                      | Explicit error if preflight detects instability             |
| Registry failure                | Complete inline fallback; central scrub still required                                        | Explicit error if fallback cannot survive scrubbing         |
| Resource absent/expired/evicted | `resources/read` error, no fallback to another session/resource                               | Same                                                        |
| Wrong/missing read session      | Resource read denied                                                                          | Same                                                        |
| Redaction disabled explicitly   | Original raw content, including malformed/raw TOML; warning in TOML text                      | Guard deliberately inactive, matching operator opt-out      |
| Redaction throws                | Tool boundary withholds inline results; strict TOML preparation withholds before registration | Same, with generic preflight error if that stage throws     |

Auto sizing uses original serialized UTF-8 bytes before redaction, including original
TOML size. Summaries report post-redaction delivered TOML bytes. A threshold is a
delivery choice, not a size ceiling. Preparation failures propagate as errors;
only registration failures trigger fallback. Empty logs/TOML may return inline
without registering an empty resource. `inline_full=false` follows configured policy.

Security/data-integrity semantics do change with delivery: JSON object structure is
preserved in registry MIME processing while serialized strings/text use heuristics;
TOML had a corrupting generic pass only on the inline path; logs have different
combined versus structured representations; resource links add session, TTL and
eviction constraints. These are real boundaries, not equivalent encodings by assumption.

## TOML findings and mitigation choice

The portable `inline-hardening-repro.mjs` executes actual tools, central result
scrubbing, registration and `resources/read`, with both export tools. It records
synthetic-secret presence and document validity separately. It exits 1 on disclosure,
invalid TOML or byte mismatches and is deliberately separate from the passing guard
regressions; it must not be described as a green security suite.

| Exact source         | Adversarial cases | Credential disclosures | Invalid document cases | Byte mismatches |
| -------------------- | ----------------: | ---------------------: | ---------------------: | --------------: |
| Upstream 1.5.1       |                40 |                     24 |                      6 |              14 |
| Integration baseline |                40 |                     24 |                      6 |               0 |
| Hardened branch      |                40 |                     20 |                      0 |               0 |

These are **case counts**, not distinct vulnerabilities. Final disclosures comprise
12/32 TOML cases, 4/4 JSON cases and 4/4 log cases. A case is one tool/delivery/input
combination; withheld results are safe failures, not delivered documents. These finite
fixtures are not proof that all other documents are safe.

Confirmed mechanisms:

1. An environment value `password="synthetic-private-credential-739"` is structurally
   scrubbed and serialized to TOML containing escaped quotes. Framework 1.3's generic
   second pass can replace a backslash and leave an unescaped quote. Both rendered
   and structured inline TOML become invalid. Exact upstream `inline_full=true`
   reproduces this without the adaptive feature. Registration and linked reads are
   valid for this particular input. Ordinary multiline and top-level basic/literal
   triple-quoted sensitive keys were separately tested and redact correctly.
2. A decoded environment string containing backslash-escaped quotes around the
   sensitive value, or nested triple quotes, defeats the existing generic heuristics.
   For example, construct the decoded string as `` `password=\\"${secret}\\"` `` and
   TOML-serialize it. Structural parsing of the outer TOML still leaves the embedded
   language to generic scrubbing. The canonical output can remain syntactically valid
   while retaining the credential. Links do not fix this. JSON configuration and raw
   logs share this inherited limitation. The new stability check is **not** a secret
   detector: some under-redacted output is already stable and passes it.
3. Upstream's linked byte count reflects the original export. The integration already
   fixed this; this branch adds no second byte-count correction.

The rejected framework patch was inspected but never executed/applied. Its quoted
string shielding/recursive processing is not copied. Its reported triple-quote bypass
and amplification were not independently rerun because the supplied previous security
evaluation object could not be located. The current framework's separate nested-quote
disclosures above were independently reproduced against the clean pinned source.

| Strategy                                           | Security / compatibility                                                                                                                        | Effort and maintenance                             | Decision                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| A: document existing behavior only                 | Keeps corrupted successes and expands exposure under inline/auto                                                                                | Lowest cost                                        | Insufficient for the confirmed serialization defect |
| B: force TOML links / exclude auto                 | Helps ordinary serialization corruption, but fails without session/registration; does not fix nested-secret disclosure; weakens ChatGPT utility | Small but incomplete                               | Not a security solution                             |
| C: reject unsafe inline serialization              | Central redaction remains active, no format rewrite, ordinary inline contract retained; affected requests explicitly fail                       | Small local guard, focused regression              | Implemented for corruption only                     |
| D: trusted MIME/field-typed result boundary        | Can parse/scrub/re-serialize the intended document while treating nested languages explicitly; must protect rendered output too                 | Framework API/design and adversarial review needed | Upstream proposal, not a local fork                 |
| E: blanket field masking / rejecting nested quotes | Conservative masking could prevent particular disclosures but destroys legitimate configuration and requires complete nested-language handling  | Compatibility cost and uncertain coverage          | No speculative production implementation            |

The implemented guard reuses the local policy scrubber, checks `scrubStructured(payload).toml`
and scrubbed rendered text for byte identity, and returns a generic error on change or
exception. It creates no bypass, caching exception, opaque placeholder mechanism or
repaired TOML. Central scrubbing still executes. `inline_full=true` remains an inline
request; only results that demonstrably cannot survive the boundary are refused.
Redaction opt-out and linked delivery retain their existing behavior and limitations.
`src/tools/toml.ts` is the **only changed production file**.

A narrowly scoped upstream design should attach serializer identity to a trusted tool
definition/output field, never trust caller-supplied MIME flags or magic text markers,
and scrub the parsed tree before serialization. Carry redacted data into typed renderers;
collect/purge literals consistently across text, structured output and resource reads.
Nested environment/Compose/script strings need explicit policy or conservative masking,
not generic quote shielding. Enforce byte/depth/work budgets and fail closed on parse,
serialization or budget failure. Review triple-basic/literal quotes, escaped quotes,
marker-bearing values, repeated passes and adversarial string counts before acceptance.

## Regression coverage and integration compatibility

The original tracked suite contains 89 tests. This branch adds 158 counted tests
(including parent test cases) for **247 total**:

- `inline-hardening.test.ts`: 60, both TOML tools over seven delivery/fallback paths,
  escaped/multiline/triple-quoted inputs, large stable and quote-heavy exports,
  rendered/structured equality, registry and read validity, cross-session denial,
  missing read session, capacity eviction, expiry, custom sensitive-field policy and
  preflight exception withholding with no cause logging. On the unchanged integration
  implementation these focused regressions produce 47 passes and 13 failures
  (including the parent failure); the hardened implementation passes all 60.
- `authorization-hardening.test.ts`: 52, anonymous read-only access, authenticated
  read/write scopes, no-scope denial, two caller credentials, unbound authenticated
  denial with no global fallback, per-resource permission pre-checks, Komodo 403/500
  denial, all seven confirmation outcomes and no downstream writes without approval.
  Client cancellation during a pending prompt also rejects late acceptance. ResourceSync
  refresh/run and real container-statistics output schemas are exercised in every mode.
- `delivery-inventory.test.ts`: 46, the remaining 15 adaptive tools over all modes,
  advertised output schemas, full public data including Compose content, JSON MIME
  reads and secret redaction. Existing tests cover the other seven tools.

Fixtures mock downstream APIs or run loopback HTTP with the actual stdio child server.
No production Komodo API, Periphery, storage, tunnel or ChatGPT session was contacted.
Authenticated in-memory tests inject server-side `AuthInfo`; they test scope/client
routing and permission enforcement, not a complete real OAuth/SSO/DPoP login flow.
Existing stdio tests verify valid category/tool exclusions and non-invocation of excluded
tools. The portable category reproduction independently confirms the unresolved typo
case: `MCP_TOOLS_ALLOWED_CATEGORIES=stakc` exposes all **88** tools on upstream and final
source, with **0 writes**. That reproduction deliberately exits 1 on exposure. This is the fail-open configuration defect tracked in #251,
not a scope bypass; no duplicate fix was added to this feature branch.

Relative to exact upstream, `src/client.ts`, `src/server.ts`, `src/auth`, permission and
confirmation helpers, polling, ResourceSync action schema and container stats schema
remain unchanged. Relative to the integration base, only the TOML guard/descriptions
change production code. Existing logging/audit calls and configuration precedence remain
intact. Framework 1.3 already supplies structured result scrubbing, MIME resource processing,
stdio sessions, authorization and elicitation cancellation; none is reimplemented here.
The local TOML structural validation still differs from the framework's best-effort
MIME fallback and cannot be removed as equivalent. No other redundant code was removed.

## Validation results

All executable results below, except exact-install probes, use the pinned source-built
framework substitution. The final checkout's manifest/lock hashes equal the baseline.

| Gate                                       | Integration baseline                      | Hardened source                                         |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------- |
| Exact `npm ci`                             | FAIL: framework tarball 404               | Same blocker; no dependency workaround committed        |
| Full `npm test`                            | 89 pass, 0 fail                           | 247 pass, 0 fail                                        |
| `MCP_SCRUB_ENABLED=false npm test`         | Existing integration report: 89 pass      | 247 pass, 0 fail                                        |
| Typecheck                                  | PASS                                      | PASS                                                    |
| Build                                      | PASS                                      | PASS                                                    |
| Production build                           | PASS                                      | PASS                                                    |
| Lint                                       | PASS                                      | PASS, 0 warnings                                        |
| Formatting                                 | PASS                                      | PASS                                                    |
| `npm run test:e2e`                         | FAIL: absent `__tests__/e2e/auth.e2e.mjs` | Same missing upstream entrypoint after successful build |
| Focused new TOML guard regressions         | 13 failures / 60 tests                    | 60 pass                                                 |
| Portable adversarial security reproduction | FAIL: 24 disclosure cases                 | **FAIL: 20 disclosure cases remain**                    |
| Category typo reproduction                 | Exposes all tools                         | Same inherited defect, #251                             |
| `git diff --check`, script syntax          | Clean                                     | PASS                                                    |

The disabled-framework-switch run explicitly re-enables Komodo scrubbing for dependent
assertions and separately tests intentional raw-export opt-out. It does not claim every
test ran with redaction disabled. Dependency audit was attempted with a 45-second bound
and timed out without producing a report; no clean-audit claim or stale PR #4 advisory
count is made. The overall quality gate is **not a complete pass**.

## Performance and memory

`inline-hardening-benchmark.mjs` uses fresh Node workers per scenario/mode, two warmups,
eight measured operations, process CPU, peak RSS and explicit result-serialization time.
Linked measurements include registration **and a full `resources/read`**. Inline
measurements include the complete structured result and rendered text. Byte counts
below are tool-call result bytes; linked resource transfer adds the full payload.
Auto-boundary rows benchmark the helper directly with multibyte UTF-8 content.
The [checked-in results artifact](inline-hardening-results.json) retains initial,
sequential repeat and interleaved runs, plus the complete synthetic security results.

Representative sequential repeat, CPU milliseconds per operation:

| Payload / delivery                        | Baseline CPU | Final CPU | Final peak RSS MiB |       Final result bytes |
| ----------------------------------------- | -----------: | --------: | -----------------: | -----------------------: |
| Large JSON / inline                       |        34.74 |     34.33 |              186.1 |                2,350,319 |
| Large JSON / link                         |        40.64 |     30.70 |              170.1 |                      594 |
| Large logs / inline                       |        13.23 |     14.63 |              152.1 |                1,155,597 |
| Large logs / link                         |        20.38 |     19.95 |              158.0 |                      568 |
| Quote-heavy TOML / inline                 |        25.35 |     21.23 |              163.8 | 134 (explicit rejection) |
| Long stable TOML / inline                 |        49.15 |     58.33 |              196.2 |                1,205,677 |
| Long stable TOML / link                   |        90.45 |     80.49 |              205.7 |                      661 |
| 12,000 small string objects / inline      |       168.44 |    229.32 |              309.5 |                1,862,009 |
| Five extra redactions + delivery / inline |       762.77 |    789.61 |              430.5 |                1,862,009 |

The stable inline TOML guard costs approximately **9.2 ms / 19%** additional CPU for
this ~1.2 MB result in the sequential repeat (initial run ~16%). It adds one full
TOML-string scrub pass plus a rendered preview pass, with no additional full serialization
or reparsing of the TOML at the guard. RSS does not show an amplification trend for
this fixture. Rejected quote-heavy inline output is not functionally comparable to the
old corrupt success and must not be called a throughput optimization.

The small-string inline result varied significantly: initial comparison 188→210 ms;
repeat 168→229 ms, up to 36%. This prompted investigation: no JSON/log helper,
renderer, registry, schema or dependency production source changes in this branch;
only the TOML function changed, which this scenario does not call. Allocation/GC and
run variability were investigated with three interleaved pairs: baseline CPU
187.61/209.21/188.16 ms versus final 183.95/206.75/184.45 ms. Medians are
188.16→184.45 ms; the large apparent JSON regression does not reproduce. Development
builds are byte-identical except `tools/toml.js`. This supports run variability rather
than a new JSON execution-path cost. Stable TOML interleaved medians are 48.57→51.13 ms
(about 5.3%); its extra scan cost is real but variable. Treat the measured 5–19% TOML
CPU overhead range as local evidence rather than a tight performance guarantee.

Auto remains inclusive at exactly 16,384 bytes and offloads at 16,385 bytes; the
multibyte fixture confirms byte rather than code-unit sizing. Direct helper CPU stays
below 0.2 ms/operation in these samples. A raw info object is serialized once by the
inline renderer, once for link preparation, and **not** additionally by an unused inline
resource factory; explicit tests protect this invariant. JSON inline still duplicates
large data into rendered text and structured output. Logs/TOML bound rendered previews,
but complete inline data and fallback remain unbounded. Repeated redaction reaches
roughly 430 MiB RSS on these modest fixtures; registry entry limits do not solve byte
amplification. No broad optimization or global budget change was made in this branch.

## Upstream and deployment readiness

A smaller upstream scope can proceed for **review**, without requiring a speculative
framework correction: preserve default links, make JSON/log inline/auto selection
explicit, retain existing schemas and complete fallbacks, and keep TOML corruption
guard/limitations separately reviewable. Update PR #242 only after maintainer agreement
on that scope, rebase to exact 1.5.1, and replace its stale SDK/Zod/publication/test claims.
Do not describe the feature or generic scrubber as credential-safe for arbitrary nested
configuration. Limiting TOML alone does not remove the JSON/log disclosure finding.

For the intended Synology + Komodo Core/Periphery + single service identity + stdio
through OpenAI Secure MCP Tunnel deployment, this branch is **blocked from rollout**
by the inherited redaction failures, unpublished framework artifact, and category
fail-open issue. The disposable stdio fixture establishes process/protocol behavior,
not Synology filesystem permissions, tunnel message limits, real Core RBAC or client
confirmation UI behavior. Read-only tools can still disclose credentials. Do not use
a production secret-bearing service account to bypass these gates.

Before a controlled live smoke test:

1. Independently review the new findings, including nested quoted strings in JSON and
   logs, and obtain a vetted upstream correction or a reviewed conservative masking/
   exposure policy. Re-run the deliberately failing reproduction to zero disclosures
   and zero invalid documents. No central redaction opt-out is an acceptable workaround.
2. Publish Framework 1.3.0 (or an agreed upstream patch), verify artifact integrity/content,
   and rerun clean exact-lock installation, all quality gates and advisory assessment.
   Restore upstream's real auth e2e suite or explicitly substitute reviewed equivalent tests.
3. Land/consume #251 separately and verify startup rejection of invalid/mixed categories
   for environment and file configuration. Independently review OAuth/SSO/DPoP routes
   before claiming authenticated-network readiness.
4. On a disposable Synology-hosted staging configuration, pin the reviewed image/commit,
   record Core/Periphery/Node/tunnel versions and config hashes, restrict mounts and service
   identity privileges, enable both secret scrubbing and destructive confirmation, use
   `MCP_CONFIRM_FALLBACK=deny`, and put `MCP_RESOURCE_RESPONSE_MODE=inline` on the MCP
   **child process**. Verify exact category and tool allow/exclude lists via `tools/list`.
5. Obtain explicit authorization for the eventual live read-only test against named
   targets. Start with tool listing and exposed health/version calls, container list/stats,
   then an approved synthetic stack's info and small synthetic logs. Confirm redaction in
   both rendered text and structuredContent, session behavior, bounded tunnel responses,
   and audit records. Real configuration/exports require disclosure review before reading.
6. Write tests need **separate explicit authorization** identifying a disposable target,
   allowed lifecycle/create/delete operations and cleanup. Verify actual tunnel elicitation
   capability and accepted/declined/cancelled behavior first. Missing capability with deny
   fallback must prevent writes; keep that setting. ResourceSync run can affect many
   resources and requires separately reviewed scope, pending diff and approval.

Recommended next development action: submit the synthetic nested-quote reproductions
for independent framework/security review and agree on a typed, bounded redaction
design. Keep this experimental branch for review; do not deploy it or update #242 as
production ready. The unavailable prior evaluation SHA remains a provenance gap.
