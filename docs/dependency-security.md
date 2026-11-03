# Dependency security maintenance — 2026-11-02

Base: PR #1, `feat/adaptive-resource-responses`, commit
`8af2bcf1dc5af8c7ce17228ca8886e1827d03ef8`. This update changes dependency locks,
adds SDK compatibility tests, and documents findings. Application implementation,
schemas, permissions, approval policy, transport configuration, and deployment are unchanged.

Follow-up: [Zod / stdio input-budget evaluation](zod-security-evaluation.md)
investigates the residual Zod finding, records demonstrated v4 incompatibilities,
and recommends upstream framework/SDK changes. It adds no runtime mitigation;
the historical dependency-update results below remain unchanged.

## Locked updates

All updates satisfy the existing parent dependency ranges. `package.json` and its
overrides are unchanged; no `npm audit fix --force` or major-version overrides.

| Package | Before → after | Purpose |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 → 1.32.2 | Six SDK advisories; configuration caveats below |
| `hono` | 4.13.1 → 4.13.16 | Five moderate advisories |
| `@hono/node-server` | 2.1.0 → 2.1.6 | Moderate static-path decoding advisory |
| `qs` | 6.15.2 → 6.17.1 | Three moderate parsing/stringifying advisories |
| `fast-uri` | 3.1.5 → 3.1.9 | Ten URI normalization advisories, low through high |
| `body-parser` | 2.3.0 → 2.4.0 | High compressed-body DoS advisory |
| `proxy-addr` | 2.0.7 → 2.0.8 | Critical IPv4-mapped IPv6 trust-subnet spoofing |
| `ip-address` | 10.4.0 → 10.7.5 | Five moderate address classification/parsing advisories |
| `@grpc/grpc-js` | 1.14.4 → 1.14.7 | High certificate-auth context and low error-disclosure advisories |
| `content-type` (body-parser copy) | 2.0.0 → 2.1.0 | Required supporting update from body-parser |
| `iconv-lite` | 0.7.2 → 0.7.3 | Supporting update from body-parser |
| `brace-expansion` (development only) | 5.0.9 → 5.0.12 | Two high and one moderate expansion DoS advisories |

`mcp-server-framework` stays **1.2.0**; its SDK range is `^1.27.1`, compatible with
1.32.2. The same SDK instance is used by the framework and development tests.
`ajv@8.20.0`, `ajv-formats@3.0.1`, `express@5.2.1`, and
`express-rate-limit@8.5.2` remain unchanged, with their affected transitives refreshed.
The direct **smol-toml 1.9.1** pin and `$smol-toml` override still cover the
framework parser. The existing `$zod` override still unifies Zod at 3.25.76.

## Production and stdio reachability

These are code-path assessments, not successful exploitation demonstrations. The
Secure MCP Tunnel's client-side implementation and limits were not inspected.

| Dependency / finding | Production path and stdio assessment |
| --- | --- |
| SDK HTTP request-body/batch DoS, GHSA-f897-62hf-6gxq (high) | Framework → SDK Streamable HTTP transport. The patched release adds default body/batch limits. Stdio does not use HTTP request handling. |
| SDK collection-validation DoS, GHSA-46jr-4wx8-v453 (high) | See opt-in limitation below. Advisory describes HTTP exposure; shared validation also processes stdio tool arguments. No claim that arbitrary-size stdio inputs are safe. |
| SDK experimental tasks, GHSA-22jm-h49p-29qw (high) | Patched SDK binds tasks to sessions. Application registers no task tools or task store; framework creates its default store only when task tools exist. No current application task path identified. |
| SDK OAuth credential destination, GHSA-6qxp-vccf-f47h (high), and cross-origin redirects, GHSA-6prh-2h8m-c8cw (moderate) | SDK HTTP **client**/OAuth functionality. This application is an MCP server, not an SDK OAuth/HTTP client. Not used for its stdio transport or downstream Komodo client. |
| SDK bearer audience, GHSA-rvq5-wwqv-78pq (moderate) | HTTP authentication only; no bearer middleware in stdio. Upgrade alone does not enable audience enforcement; details below. |
| Hono / node-server | SDK's Node HTTP transport uses the adapter. No HTTP listener in stdio. Hono SSG and JSX rendering APIs are not used by the application; their findings are not general HTTP-server exposure. |
| Express → body-parser / qs / proxy-addr; express-rate-limit → ip-address | Installed production HTTP dependencies. No inbound query/body/IP middleware in stdio. The specific qs comma/stringify options and proxy trust-subnet preconditions were not demonstrated in this application. |
| SDK → AJV → fast-uri | Installed production schema/URI machinery, including elicitation response validation in stdio. Thus not classified as HTTP-only. No attacker-controlled URI allowlist or network-fetch sink using fast-uri was found; AJV is not configured with a remote `loadSchema` callback. The advisory SSRF impact is not demonstrated here. |
| Framework → optional OpenTelemetry → grpc-js | Included by a default install (optional production dependency). Telemetry is off by default and independent of MCP transport. Its exporters are gRPC clients; no application gRPC server or `getAuthContext` use was found. Not accurately described as HTTP-only, but the advisory server preconditions were not identified. |
| Zod | Framework/tool validation and SDK protocol validation run in stdio too. See remaining high finding below. |
| brace-expansion / minimatch | ESLint development dependencies; omitted by a production-only installation. No MCP request path. |

## Remaining findings and deferred protections

| Finding | Severity | Reachability and reason for deferral |
| --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://osv.dev/vulnerability/GHSA-mrhx-c7xc-m3w5), `zod@3.25.76` | **High**, CVSS 7.5 | Scanners mark versions below 4.6.6 affected. Zod validates protocol and tool inputs over stdio as well as HTTP; some application arrays have no length cap. SDK imports `zod/v4` bundled in this package while framework/tool schemas use v3. Exact exhaustion thresholds and an exploit against this server were not tested. No compatible v3 fix is available. Forcing Zod 4 would violate framework 1.2.0's `^3.25.0` contract and risks schema/API changes. Defer to a separately reviewed framework/Zod migration or compatible upstream backport. Do not treat stdio or the tunnel as an established mitigation. |
| [GHSA-g3hv-75wg-m249](https://osv.dev/vulnerability/GHSA-g3hv-75wg-m249), `minimatch@10.2.5` | **Moderate** | Development-only ESLint glob processing, requiring attacker-controlled patterns with `optimizationLevel >= 2`; no production dependency path. OSV fix starts at 11.0.1, outside the consumers' current 10.x ranges. Even 10.2.6 remains flagged, so a non-remediating update was excluded. Defer to the lint-toolchain's compatible major upgrade; no override or suppression. |

Two SDK advisories disappear from version-based scans but are **not fully
remediated by upgrading alone**:

- **GHSA-46jr-4wx8-v453 (high):** `maxToolInputElements` is unset by default.
  Framework 1.2.0's `McpSession` does not pass this option to `McpServer`. Its HTTP
  parser already defaults to a 1 MB body limit, which does not establish a safe
  collection-validation budget. Selecting/enforcing an input budget requires
  separate framework/application work and could alter accepted inputs. Deferred
  here to preserve schemas and behavior; the Zod residual risk also remains.
- **GHSA-rvq5-wwqv-78pq (moderate):** framework `createSdkBearerMiddleware()` does
  not set `expectedResource`, and its local-login provider returns tokens from a
  local registry rather than accepting arbitrary issuer tokens. The current
  application configures only local Komodo login, with no external OAuth
  providers. Cross-service audience acceptance was not demonstrated. Any future
  shared-issuer HTTP integration needs explicit audience verification and
  matching `AuthInfo.resource`; it is not automatically protected by this bump.

SDK OAuth-client fixes also require issuer binding for bundled providers or
previously saved credentials; this application does not use those client paths.

## Validation

Executed locally with **Node.js 22.16.0**, npm 11.9.0:

- Fresh `npm ci`: passed, 335 packages, including optional dependencies.
- Baseline `npm test`: 137 passed. Updated `npm test` and
  `MCP_SCRUB_ENABLED=false npm test`: **144 passed each**.
- `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`,
  and `git diff --check`: passed.
- Added six SDK/framework boundary scenarios using a real destructive handler
  with mocked downstream calls: insufficient scope, invalid arguments, missing
  elicitation, declined/cancelled approval, and accepted approval executing once.
  Existing tests retain adaptive delivery, redaction, resource isolation, and
  bounded-worker TOML security coverage.
- Compared all **88 serialized tool definitions** across old/new SDK builds:
  input/output schemas, descriptions, annotations, and metadata unchanged.
- Actual stdio subprocess: initialize, 88 matching tool definitions, ping,
  resource-template listing, and invalid-input rejection passed, without Komodo
  credentials or a configured endpoint. No live server mutations or tunnel test.
- `npm ls` confirms framework 1.2.0, SDK 1.32.2, and shared smol-toml 1.9.1.

Security scan commands (OSV Scanner **2.5.0**, matching the existing CI action):

```sh
npm audit --omit=dev --json
npm audit --json
osv-scanner scan source --lockfile=package-lock.json --format=json
```

OSV baseline: **39 distinct advisories** across 12 affected package versions
(35 production/optional advisories, four development-only). Updated: **two**
distinct advisories, Zod and minimatch above. The 37 removed version findings
are not 37 demonstrated application exploits or complete mitigations of the
opt-in SDK issues. OSV's JavaScript scan provides package matching, not call
analysis; source inspection supplies the reachability assessments above.

Production npm audit retains **four high affected-package entries** propagated
from the **single Zod advisory** (Zod, framework, SDK, zod-to-json-schema); the
baseline had 21 affected-package entries, including two critical. Full audit
retains 17 package entries (four high, 13 moderate), propagating the same two
underlying advisories through production and development parents. Audit/OSV
exit nonzero because findings remain; they are not clean scans. Nothing is
suppressed. Advisory databases and npm's transitive propagation can change.

The existing GitHub validation/OSV workflows filter PRs to `main`, so the
separate draft PR against the feature branch may not trigger them. These are
local validation results, not a claim of hosted CI success. No workflow,
Docker, credentials, permissions, OpenAI tunnel, or home-infrastructure changes;
no deployment, image publication, or merge.
