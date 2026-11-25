# Dependency security maintenance on Komodo MCP Server 1.5.1

This follow-up rebases the dependency and authorization checks from fork PR #4
onto the adaptive response feature. The earlier dependency inventory and results
for Framework 1.2.0 remain in the [original security branch][original].

## Locked changes

`@hono/node-server` moves from 2.1.5 to 2.1.6 under the existing SDK dependency
range. The 1.5.1 lockfile already contains the other versions selected in the
original follow-up, including MCP SDK 1.32.2. Framework 1.3.0 uses Zod 4.6.7 and
smol-toml 1.9.1. The application manifest and runtime code are unchanged.

The Hono adapter is used by the SDK's Node HTTP transport. The advisory is a
package version finding and the update does not change the permissions granted
to HTTP or stdio callers.

## Validation

The authorization regression drives the real MCP SDK and framework against a
fixture for Komodo writes. It covers insufficient scope, invalid arguments,
missing elicitation, declined and cancelled approval, and one write after
explicit approval.

Check the full and production dependency trees using `npm audit --json` and
`npm audit --omit=dev --json`. Other findings remain in the release dependency
tree, including optional HTTP telemetry and development tooling. The Zod and SDK
input budgets are tracked in the [stdio evaluation](zod-security-evaluation.md).

[original]: https://github.com/ka0n/komodo-mcp-server/tree/ed360142303dc8e3a088af8c370bcea73359ad39
