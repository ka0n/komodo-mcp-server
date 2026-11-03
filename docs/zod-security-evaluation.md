# Zod / stdio input-budget evaluation — 2026-11-02

## Decision

**No application remediation is implemented. GHSA-mrhx-c7xc-m3w5 remains open.**
There is no clean dependency-only or public-configuration fix with
`mcp-server-framework@1.2.0`. Do not override the framework to Zod 4 or patch its
installed copy. Recommend an additive upstream framework hardening release,
with a separate SDK transport improvement for coverage before protocol validation.

Evaluation branch: `fix/stdio-validation-budget`, based directly on PR #2's head,
`30bebf103a4eb65f06c7c5931a4d6fdf0b574b67`. Only this report and bounded evaluation
tests are added. Dependencies, application implementation, configuration defaults,
public tool schemas, tools, permissions, approval policy, redaction, and resource
delivery are unchanged. No remediation PR is opened because no application fix
has been validated. No deployment, image publication, merge, or infrastructure
change is involved.

## Can Zod 4.6.6 preserve the existing v3 contract?

**No, as a drop-in root dependency.** The framework depends on `zod: ^3.25.0`
and re-exports `z` from `zod`. Application schemas therefore use that root API.
The SDK permits `^3.25 || ^4.0`, but that does not widen the framework's contract.
The framework's latest published version is still 1.2.0. Its upstream source at
`d2bd7a9b4136d9ccc4fba152bb94cc163552d517` also lacks both input-limit options.

An isolated detached checkout of PR #2 was installed with its original lockfile;
only that checkout's Zod directory was replaced with the published **4.6.6**
tarball. This deliberately unsupported dependency tree was an experiment, never
an application change. It demonstrated:

- `npm run typecheck` and `npm test` stop at three `TS2554` errors: the existing
  one-argument `z.record(z.unknown())` calls in `schemas/shared.ts` (two) and
  `schemas/resource-sync.ts` (one) no longer satisfy the v4 signature.
- Loading the tool registry fails before tool discovery. Existing duration
  defaults reach their numeric pipe as strings, producing `ZodError` for
  `KOMODO_API_TIMEOUT_MS`, `MCP_RESOURCE_TTL_INFO`, `MCP_RESOURCE_TTL_LOGS`, and
  `MCP_CONFIRM_TIMEOUT_MS`. V4's default short-circuit behavior bypasses the
  transform that the v3 default passed through. This is a real startup failure,
  not just a type declaration mismatch.
- A small independent semantics probe confirms another change:
  `z.object({ flag: z.boolean().default(true).optional() }).parse({})` produces
  `{}` with the current v3 but `{ flag: true }` with v4. A migration needs explicit
  schema/default and generated-schema review, not just compilation fixes.

Importing `zod/v3` from a 4.6.6 package preserves the legacy collection parser,
not the security fix. With 4,096 invalid entries, `z.array(z.string()).max(16)`
reports **4,097 issues** in both installed v3 and 4.6.6's bundled v3, versus **one**
issue with 4.6.6's root v4 API. Simply making a package-version scanner green
would misrepresent this legacy path. Changing only the application imports also
leaves the framework's own v3 validation in place.

The [advisory](https://osv.dev/vulnerability/GHSA-mrhx-c7xc-m3w5) marks all versions
below 4.6.6 affected. The 4.6.6 implementation's `capSize()` rejects oversized
**size-constrained** arrays/maps/sets before parsing children. It does not install
a general element or issue cap on unconstrained collections. The bounded probe
of an unconstrained v4 string array still produces 4,096 issues. Thus a future
v4 migration should retain transport/input budgets as defense in depth.

## Stdio validation order and existing limits

```text
stdin bytes
  -> ReadBuffer.append (default 10 MiB aggregate buffered-byte limit)
  -> newline framing / UTF-8 decoding
  -> JSON.parse
  -> JSONRPCMessageSchema.parse (SDK's bundled zod/v4)
  -> protocol request / notification / response schema validation
  -> tools/call: optional maxToolInputElements check
  -> tool input Zod validation
  -> framework permissions / approvals / handler / output delivery
```

This describes the tool-call path; permission checks inside handlers remain
authoritative, and other protocol methods do not enter tool validation.

| Control | Verified behavior | Limitation |
| --- | --- | --- |
| SDK `ReadBuffer` / `StdioServerTransport.maxBufferSize` | Default **10 × 1024 × 1024 bytes**, enforced before JSON/Zod parsing. Overflow clears the buffer and the transport closes. | It bounds aggregate buffered input, including multiple lines in a single chunk, rather than strictly each message. No element, nesting-depth, or issue cap. Framework constructs the transport without options. |
| SDK `McpServer.maxToolInputElements` | Default unset/unlimited. With a finite value it iteratively counts array entries and own object members, including nested/unknown members, before tool-schema parsing. | Only tool arguments, after protocol validation. Not a general limit on initialization, notifications, client responses/elicitation, strings, nesting depth, or concurrent work. Framework does not forward it. |
| Zod v3 `.max()` / `.length()` | Rejects oversized collections semantically. | Continues validating children and accumulating issues. Adding these to public schemas is not early rejection and changes accepted input. |
| HTTP body and batch limits | Separate HTTP parser/SDK controls. | Not applied to stdin. Tunnel-side limits were not inspected and are not assumed. |

A real `komodo_stack_apply` request with 4,096 zeroes in `config.links` is just
**8,345 bytes** and yields 4,096 issues when parsed by the existing schema.
Even a 1 MiB byte ceiling could contain roughly half a million compact numeric
array entries. The 10 MiB stdio cap is useful but does not establish protection
against collection-validation amplification. No exhaustion-sized input or
production exploit was executed.

Source evidence:

- [Framework SDK construction](https://github.com/MP-Tool/mcp-server-framework/blob/d2bd7a9b4136d9ccc4fba152bb94cc163552d517/src/server/session/mcp-session.ts#L210-L228)
  forwards capabilities and task stores/queues only.
- [Framework stdio construction](https://github.com/MP-Tool/mcp-server-framework/blob/d2bd7a9b4136d9ccc4fba152bb94cc163552d517/src/server/transport/stdio-transport.ts#L39-L47)
  uses `new StdioServerTransport()`.
- The builder and session factory assemble sessions internally. `CreateServerOptions`,
  `ServerOptions`, `McpSessionOptions`, and `StdioTransportOptions` provide no
  supported way to supply these limits. Lifecycle hooks expose session IDs,
  not a pre-validation transport or SDK construction hook.
- Installed SDK 1.32.2: `dist/esm/shared/stdio.js`, `server/stdio.js`,
  `server/mcp.js` (`validateToolInput`), and `shared/protocol.js`.
- Published Zod 4.6.6: `v4/core/schemas.js` (`capSize`, `$ZodArray`) and
  `v3/types.js` (`ZodArray._parse`).

## Recommended upstream work

1. **Small framework addition: expose typed SDK limits.** Thread a finite
   `maxToolInputElements` setting through create-server options, builder, session
   factory, and `McpSession` into the `McpServer` constructor for every session.
   Expose the SDK stdio `maxBufferSize` through stdio options and transport
   construction. Validate finite positive safe integers; do not silently accept
   invalid settings or disable the limit. Keep scope gating, registry binding,
   session IDs, tasks, subscriptions, result scrubbers, and resource delivery on
   their existing paths. This requires no framework fork or major migration.
2. **Complete early protection upstream in the SDK transport.** Add a bounded,
   iterative count/depth check on decoded JSON **before**
   `JSONRPCMessageSchema.parse`, covering all incoming messages. Keep the byte
   guard before JSON parsing. A guard on `transport.onmessage` is already too
   late for the envelope parse. Prefer an SDK option the framework can forward
   rather than maintaining a duplicate NDJSON parser in this application.
   Test fragmented/coalesced lines, CRLF, byte/element/depth boundaries, malformed
   JSON, oversized requests/notifications/responses, and close/error semantics.
3. **Defaults require an explicit compatibility decision.** Optional settings
   defaulting to the SDK's existing values preserve behavior but do not protect
   existing installs automatically. A secure finite default rejects some inputs
   previously accepted even if public JSON Schemas stay identical. Candidate
   evaluation values are 1 MiB buffered bytes, 1,024 tool elements, and depth 64;
   these are sizing starting points, not proven production-safe defaults.
   Measure legitimate compose/TOML/config payloads, union-validation cost, and
   concurrent requests before choosing defaults. Large single strings and
   elicitation replies also need review. Document overrides and rejection
   behavior. The tests below validate mechanics, not a universal memory budget.
4. **Longer-term dependency remediation:** seek a supported Zod v3 backport or
   framework release with an audited v4 migration. A constrained-collection
   backport alone still leaves unconstrained schemas needing input budgets.
   Re-run tool-definition snapshots, configuration/default semantics, scope and
   destructive-approval tests, redaction, and all resource-delivery modes before
   consuming a new framework version. Keep the advisory visible until the
   dependency and reachable paths are actually addressed.

| Alternative | Trade-off / disposition |
| --- | --- |
| Framework passthrough for tool and stdio limits | Small, generally useful, preserves v3 and public schemas. Recommended first step; tool guard alone is partial protection. |
| SDK guard before all protocol validation | Broader early protection without an application parser fork. Recommended companion change. |
| Force root Zod 4 / override constraints | Demonstrated compilation and startup failures; rejected. |
| Use 4.6.6's `zod/v3` everywhere | Retains vulnerable parser; rejected as a remediation. |
| Add only array `.max()` or handler-level checks | V3 still parses children; handlers run after validation. Rejected as an early guard. |
| Patch node_modules, private SDK fields, stdin, or framework prototypes | Unsupported coupling with session/security machinery; rejected. |
| Application-owned stdio proxy / custom session assembly | Duplicates framing, backpressure, session and lifecycle behavior; too much application change for this fix. |
| Full framework/Zod migration | Possible separately, but changes APIs, defaults, schema generation, and error semantics. Not authorized automatically here. |

## Validation

`src/tools/zod-security.test.ts` adds four bounded checks, each in a separate
process with `--max-old-space-size=128`, `--max-semi-space-size=4`,
`--stack-size=512`, a **30-second SIGKILL timeout**, and a **16 KiB output cap**.
These are V8 memory limits, not an operating-system RSS ceiling. Inputs are
capped at 4,096 entries or the existing SDK byte-buffer boundary. Network calls
are forbidden in the child scripts. No test deliberately attempts OOM.

- Invalid collections are rejected by a real application schema and a constrained
  v3 array within the isolated process.
- With an explicitly configured SDK element guard, valid/invalid oversized
  arrays, object members, nested collections, and unknown members are rejected
  with **zero schema-preprocess calls and zero handler executions**. An exact
  1,024-element boundary passes; an ordinary invalid input fails without execution.
- A configured SDK stdio byte cap accepts fragmented CRLF input, then closes on
  overflow before any further message delivery.
- The SDK's existing default buffer cap rejects overflow and clears stale bytes.

These checks exercise SDK mechanisms and bounded application validation. They do
**not** assert that framework 1.2.0 configures the options or that the application
has been remediated. The unsafe large-input threshold is intentionally unmeasured.

Results on the unchanged PR #2 dependency lock:

- Fresh `npm ci --ignore-scripts --cache /tmp/komodo-npm-cache`: passed,
  335 packages. The separate cache accommodates this environment's writable paths.
- Baseline suite before adding tests: **144 passed** on Node.js 24.19.0.
- Complete final `npm test`: **148 passed** on Node.js **22.16.0** and
  **24.19.0**. `MCP_SCRUB_ENABLED=false npm test`: **148 passed** on 24.19.0.
  This includes existing permission/approval, redaction, adaptive delivery,
  resource isolation, configuration, and TOML security checks.
- Lint (including `eslint-plugin-security`), formatting, typecheck, build,
  `npm ls --all`, and `git diff --check`: passed.
- `npm audit --omit=dev --json`: **two high affected-package entries**, Zod and
  framework, propagated from the single Zod advisory.
- `npm audit --json`: **17 entries** (four high, 13 moderate), propagated from
  Zod and the existing development-only minimatch finding.
- **OSV Scanner 2.5.0**, `scan source --lockfile=package-lock.json --format=json`:
  **two distinct advisories**, Zod **GHSA-mrhx-c7xc-m3w5** (high) and minimatch
  **GHSA-g3hv-75wg-m249** (moderate), unchanged from PR #2. Scans exit nonzero;
  no finding is suppressed. npm's package-entry attribution differs between
  full and production-only reports; it is not a count of distinct advisories.
- The intentionally unsupported isolated Zod 4 checkout **failed** typecheck,
  test compilation, and tool-registry startup as described above. It is not a
  candidate validated upgrade.

These are local results. CodeQL and hosted dependency-review workflows were not
run; existing PR workflows target `main` and no PR is opened for this evaluation.
