# Zod and stdio validation on Komodo MCP Server 1.5.1

Framework 1.3.0 natively uses Zod 4. The 1.5.1 lockfile resolves Zod 4.6.7 and
MCP SDK 1.32.2, with no Zod 3 runtime package or version override. This replaces
the Framework 1.2.0 dependency graph described in the
[original evaluation][original]. It does not add an application input limit or
establish a safe maximum size for messages or tool arguments.

The earlier report tracked GHSA-mrhx-c7xc-m3w5 against Zod 3.25.76. The migration
changes the installed package version. These tests verify that ordinary invalid
inputs are rejected and exercise the SDK's limit options. They do not reproduce
the advisory or prove its mitigation at the application boundary.

## SDK limits and coverage

The framework constructs its SDK `McpServer` and `StdioServerTransport` without
selecting custom `maxToolInputElements` or `maxBufferSize` values. Its SDK uses
the default stdio buffer cap. The SDK element-budget option is opt-in.

The tests check Zod 4 application schema rejection, SDK tool-input limits with
an explicit small budget, and SDK stdio behavior with explicit and default
buffer limits. The subprocess checks are isolated and time-bounded. Only the
default transport behavior applies directly to an unconfigured application.

[original]: https://github.com/ka0n/komodo-mcp-server/blob/ed360142303dc8e3a088af8c370bcea73359ad39/docs/zod-security-evaluation.md
