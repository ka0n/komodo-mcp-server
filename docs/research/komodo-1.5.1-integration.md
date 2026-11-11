# Komodo MCP 1.5.1 adaptive-response integration experiment

Date: 2026-11-11. Target repository: `ka0n/komodo-mcp-server`.
Branch: `experiment/komodo-1.5.1-integration`.

## Result and scope

The adaptive-response feature is ported onto the exact upstream 1.5.1 snapshot.
It is suitable for experimental review, subject to the dependency-publication blocker below.
It is not a production migration or a claim of release readiness.

No existing branch or PR was rewritten or updated. There is no PR creation, merge, deployment,
infrastructure change, or SDK v2 migration. The original checkout remains on its original `work`
branch; integration uses a separate worktree. The baseline worktree has no source changes.

## Exact inputs and replay

- Upstream repository: `MP-Tool/komodo-mcp-server`.
- Exact upstream base: `161bc0d01af881118d14ca85c838e524284c76dd`.
- Original feature base (1.5.0): `489f7e04b16019480f84e1d2fff8b872b880e335`.
- Original feature head: `41c1fe40b3388c5c1957788d758455f8457a3c80`.
- Separate security head, **not replayed**: `ed360142303dc8e3a088af8c370bcea73359ad39`.
- Its first security-only commit, also **not replayed**:
  `3fe181eb9ea3ae2c0f798cea40b145a3b614ce0d`.

Fetched the fork branches and PR refs plus upstream branches and PR refs. Verified all input
commits with Git, their parent relationships, authors, and PR heads through GitHub's API.
At inspection, upstream release PR [#244](https://github.com/MP-Tool/komodo-mcp-server/pull/244)
pointed to the exact requested base. Upstream feature PR
[#242](https://github.com/MP-Tool/komodo-mcp-server/pull/242) and fork PR
[#5](https://github.com/ka0n/komodo-mcp-server/pull/5) pointed to the feature head; fork PR
[#4](https://github.com/ka0n/komodo-mcp-server/pull/4) pointed to the separate security head.
All four were open.

The six commits after the original feature base were cherry-picked in order with `-x`.
All retain author `ka0n <3476405+ka0n@users.noreply.github.com>` and original author dates.
The source SHA is also retained in each commit message.

| Original SHA                               | Migrated commit | Purpose                                           |
| ------------------------------------------ | --------------- | ------------------------------------------------- |
| `61205b5f3b2b04eb0f1426b4792821fd0c4b8fc1` | `dda9426`       | Delivery modes and threshold                      |
| `43aae307e97946851686b61cf3c63cc0a5a337f5` | `12e26ee`       | Review fixes, strict TOML guard, descriptions     |
| `1ba0e5d09a9fa1142543fe84b035c63196b1b9ac` | `70fd6f0`       | Lazy resource preparation and PR CI               |
| `8878694edff5f5ce76002951cc98e15baf0278a7` | `9579c5d`       | TOML parser/security regressions and opt-out text |
| `b5da719b91c4e4e94f5b5be504e43006d5f5ebd5` | `2e60d92`       | `inline_full` documentation                       |
| `41c1fe40b3388c5c1957788d758455f8457a3c80` | `d779f61`       | ChatGPT stdio tunnel recipe                       |

Integration adjustment commit `bbfeed50c61508eb47052ca52eb49ea5f20a4f81` follows the replay;
this report is committed separately.
Replay commits preserve the development sequence and are not all independently installable;
the final branch is the review target.

## Conflicts and resolutions

1. **CHANGELOG.md:** both histories inserted material ahead of 1.5.0. Kept the feature's
   Unreleased section followed by the entire upstream 1.5.1 release notes.
2. **Deleted tests:** upstream removed tracked tests while moving its local tests into ignored
   `__tests__` directories. Restored the feature-modified `src/config/env.test.ts` and
   `src/utils/redact.test.ts`, together with the feature's added suites, as tracked sibling
   `*.test.ts` files. Extended the existing ESLint test override to these files. Production
   TypeScript builds still exclude tests; the upstream test command includes them.
3. **package.json/package-lock.json:** retained upstream framework `~1.3.0`, SDK 1.32.2,
   Zod 4 and all upstream locked packages. The only final manifest/lock difference is declaring
   the already-locked `smol-toml@1.9.1` directly. No separate security dependency set was applied.
4. **Tool imports:** conflicts in action, alerter, build, builder, deployment, procedure, repo,
   resource-sync, server, stack and swarm were resolved by adding the delivery-description
   import while keeping upstream `ValidationError` instead of restoring `AppErrorFactory`.
5. **Builder and TOML schemas:** kept upstream `.extend(inlineFullInputSchema.shape)` instead
   of the feature's older `.merge(...)` calls. Combined delivery descriptions with those APIs.
6. **TOML result builder:** combined strict parse/scrub/serialize/validate and generic failure
   results with upstream `ToolResultFor<typeof tomlOutputSchema>`. Kept upstream error classes.

The later two documentation commits applied without conflicts. Lazy resource preparation
merged with upstream's structured result changes without a textual conflict; the final diff
and compilation verify that `komodoObject`, `InfoResultPayload`, typed `buildInfoResult`, and
object output schemas remain intact.

## Final feature changes and redundant work

- Default `link`, explicit `inline`, and inclusive UTF-8 threshold `auto` remain supported.
  `inline_full: true` always selects inline; omitted/false follows server policy. Invalid modes
  and thresholds fail configuration validation, including file/env precedence checks.
- Kept upstream Zod 4's `.int().positive()` checks. Removed the feature's redundant/deprecated
  `.safe()` calls: Zod 4 integer validation already enforces the safe-integer range.
- No Zod 3 override or direct Zod 3 dependency was restored. The feature's old parser override
  is unnecessary because upstream already locks the parser to 1.9.1. Its direct declaration
  remains necessary for this application's strict TOML imports.
- Updated the scrubber-failure injection from `scrubObject` to `scrubStructured`, which is the
  framework 1.3 tool-result boundary. This preserves a meaningful fail-closed regression.
- Adapted the unsafe-integer TOML config assertion: parser 1.9.1 can reject an unrepresentable
  integer before schema validation names the setting. Other invalid cases must still identify
  the setting. The test requires failure in either case.
- Preserved lazy JSON/log preparation, complete-inline fallback on registration failure or
  missing session, byte-based threshold selection, original TOML byte sizing for `auto`,
  post-redaction `summary.bytes`, and bounded rendered previews with full structured data.
- Strict local TOML redaction remains necessary. The framework's best-effort MIME fallback
  does not provide the same structural fail-closed guarantee. Malformed/non-string exports,
  scrubber/serializer failures and unsafe serialized output are withheld with generic errors.
  Explicit redaction opt-out retains the original raw-export behavior.
- Preserved upstream resource-sync refresh structured output and run semantics, container
  list statistics, per-caller credentials/forwarding, authorization, and service-client rules.
  `src/server.ts`, `src/client.ts`, auth implementation, and permission/confirmation helpers
  have no integration changes relative to the requested upstream snapshot.
- The feature's independent PR CI remains useful: the exact target's `pr-check.yml` does not
  run active unit-test/lint/format jobs, despite earlier commits in its history. It stays
  read-only and PR-triggered. No release/publishing workflows were changed.

## Dependency-publication blocker and validation method

The environment's initial Node 24.19.0 is below upstream's required engine range. Validation
uses Node **24.22.1** and npm **11.9.0**, with no engine bypass or repository engine changes.

An exact baseline `npm ci` fails with **HTTP 404** fetching:

`https://registry.npmjs.org/mcp-server-framework/-/mcp-server-framework-1.3.0.tgz`

The registry lists 1.2.0 as latest. The integration's exact-lock install was also checked in a
disposable directory. This is an upstream publication prerequisite, not a feature regression.

To continue useful validation, fetched the framework's 1.3.0 branch into a separate workspace,
pinned it to **`706db031cc19c0ec246c078c216e904343690b67`**, installed its lockfile, built it and
packed it locally. Temporarily substituted only the framework lock entry's `resolved` URL with
that local archive for baseline installation, then restored the original upstream lockfile.
The integration uses a copy of those installed dependencies: the only extra direct feature
dependency, parser 1.9.1, is already present at that exact locked version.

All source/build/test checks below use this **source-built framework substitution**. They do
not establish equivalence to a future npm publication. The committed lockfile still targets
the upstream npm artifact; it contains no local archive, path, link or Git dependency.
Baseline `git status --porcelain` was empty after validation.

For reproducibility: clone `MP-Tool/mcp-server-framework`, check out the exact SHA above,
use a supported Node version, run `npm ci`, `npm run build`, and `npm pack --ignore-scripts`.
In a disposable Komodo checkout, save the lockfile, change only
`packages["node_modules/mcp-server-framework"].resolved` to the archive's absolute `file:` URI,
run `npm ci`, and restore the saved lockfile before checking source. Do not commit that
substitution or treat it as a production dependency workaround.

## Test results

All commands use Node 24.22.1/npm 11.9.0. Except for the exact-install probes, checks use the
source-built framework substitution described above.

| Check                              | Unmodified upstream 1.5.1                   | Final integration                                 |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Exact-lock `npm ci`                | Fails: framework 1.3.0 tarball HTTP 404     | Same HTTP 404 in disposable install probe         |
| `npm test`                         | Pass, **0 tests** (tracked suites absent)   | **89 passed, 0 failed**, 58.51 s test-runner time |
| `MCP_SCRUB_ENABLED=false npm test` | Not rerun; no tracked tests                 | **89 passed, 0 failed**, 68.07 s test-runner time |
| `npm run build`                    | Pass                                        | Pass                                              |
| `npm run build:prod`               | Pass                                        | Pass                                              |
| `npm run typecheck`                | Pass                                        | Pass                                              |
| `npm run lint`                     | Pass                                        | Pass, no errors or warnings                       |
| `npm run format:check`             | Pass                                        | Pass                                              |
| `npm run test:e2e`                 | Fails: missing `__tests__/e2e/auth.e2e.mjs` | Same missing-file failure after successful build  |
| `git diff --check`                 | Clean source checkout                       | Pass                                              |

The two remaining required-command failures are shared with upstream: the exact locked
install and the stale e2e script. No failing feature regression remains in the tested source
configuration. Redaction-dependent tests explicitly enable the policy where required; separate
cases verify explicit raw-export opt-out. The inherited disabled switch run is not a claim
that every redaction assertion was executed with scrubbing disabled.

Initial sandboxed subprocess checks returned `EPERM`; the final test runs used approved
execution outside that sandbox for child processes and loopback fixtures. Earlier actionable
test failures were the stale scrubber-method injection and the parser's earlier unsafe-integer
rejection, both adapted as described above. Neither required weakening runtime redaction or
changing upstream security behavior.

The added `src/tools/integration-1.5.1.test.ts` exercises the real child-server entrypoint over
stdio against a loopback Komodo fixture. It verifies all three policies, structured output
schemas, JSON/TOML redaction, resource reads, category/tool exclusions and denial of deletion
when the client cannot elicit confirmation. All downstream credentials and data are synthetic.
No production service is contacted.

Framework 1.3.0 source supplies stdio session IDs: link/large-auto now offload successfully over
stdio. Inline mode returns complete structured data without materializing a resource. The
ChatGPT/OpenAI Secure MCP Tunnel recipe therefore remains applicable: put
`MCP_RESOURCE_RESPONSE_MODE=inline` on the MCP child process. No actual OpenAI tunnel or
ChatGPT connection was available in this experiment; this is a protocol/process compatibility
test, not a new live-tunnel certification.

Additional integration coverage verifies per-user versus registered-service/global client
routing and denies authenticated requests without a bound identity. Across each policy,
read-only scopes cannot delete, declined/cancelled confirmation never writes, and accepted
confirmation writes exactly once. Existing feature suites cover missing sessions, registry
failures, TTL/entry limits, cross-session reads, exact/multibyte thresholds, lazy serialization,
TOML parser regressions and fail-closed redaction. Expected warning/error logs from injected
failures are not test failures.

## Separate assessment of fork PR #4

Neither security-only commit was needed for integration. No files from that follow-up's
dependency/security reports or SDK/Zod test suites were copied into this branch. The new
authorization/confirmation regressions are written for the integration's three delivery modes.

PR #4 was based on framework 1.2.0 and Zod 3. Its dependency delta is largely superseded by
the exact upstream target. Comparing its lock changes with 1.5.1 gives:

| PR #4 package updates                                                  | Upstream 1.5.1 status                         |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| SDK 1.32.2, grpc-js 1.14.7, body-parser 2.4.0, content-type 2.1.0      | Already present                               |
| brace-expansion 5.0.12, fast-uri 3.1.9, hono 4.13.16, iconv-lite 0.7.3 | Already present                               |
| ip-address 10.7.5, proxy-addr 2.0.8, qs 6.17.1                         | Already present                               |
| `@hono/node-server` 2.1.6                                              | Target still locks 2.1.5; evaluate separately |

Do not replay the security lock wholesale: it would reintroduce older framework/Zod assumptions
and obscure upstream updates. Its Zod-v3-specific reachability/advisory conclusions are stale
for the target's Zod 4.6.7. Rewrite them against the actual release graph before proposing a
security PR. Framework 1.3.0 source still does not expose the SDK's `maxToolInputElements` or
stdio `maxBufferSize` options as application configuration; a newer major Zod version alone
does not establish an application-wide input budget.

An optional full `npm audit --json` was attempted but produced no report after over three
minutes and was terminated. No clean-audit claim is made. Re-run dependency/advisory analysis
separately after publication, including `@hono/node-server`, optional telemetry and development
dependencies. Do not carry forward PR #4's old vulnerability counts as current findings.

## Remaining risks and recommended next steps

1. Publish/resolve framework 1.3.0, then rerun clean locked installs, both test configurations,
   build, typecheck, lint, formatting and hosted CI against that exact artifact. If its contents
   differ from the pinned source snapshot, review those differences first.
2. Restore or obtain upstream's unpublished local e2e/auth tests. The repository's advertised
   e2e command currently references an absent file; the integration does not manufacture a pass.
3. Re-run a controlled ChatGPT/OpenAI Secure MCP Tunnel stdio smoke test on this exact branch,
   including info, logs and TOML with inline mode, and a separately authorized confirmation flow.
4. Exercise the new network-auth paths against a disposable real Komodo instance. Unit routing,
   mocked API handlers and SDK approval tests do not certify OAuth/SSO/DPoP or real Komodo RBAC.
5. Keep PR #4's dependency/security evaluation separate and update its framework/Zod assumptions.
6. Inline and fallback responses can be arbitrarily large; `auto` is a delivery threshold, not
   an absolute size cap. Large inline exports retain serialization/redaction CPU and memory
   costs. Preserving upstream behavior here is intentional for this scoped experiment.

Recommendation: use this branch for independent review and integration feedback now. **Do not
update upstream PR #242 as release-ready yet**: first clear the framework publication blocker,
repeat validation against the published lockfile, and obtain fresh auth/tunnel smoke evidence.
Once those gates pass, prepare a focused future PR update from this port, keeping security
maintenance separate. No existing upstream or fork PR was updated by this experiment.
