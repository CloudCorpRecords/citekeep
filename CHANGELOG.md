# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Koskamo cited knowledge MCP server. Five kept tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `koskamo_retrieve`, `koskamo_list_datasets`, `koskamo_get_history`, `koskamo_list_revisions`, `koskamo_find_mcp_server` — sourced passage retrieval from public datasets, the public dataset list, a dataset's document-version timeline, its pending-revision list, and a search of the MCP-server directory.
- Labelled subset: `koskamo_propose_revision`, `koskamo_decide_revision` and `koskamo_register_mcp_server` are omitted and absent at registry, MCP and CLI level.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `citekeep error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `KOSKAMO_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
