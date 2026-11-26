# citekeep

Get answers you can actually cite. citekeep is a small forwarding client for the hosted Koskamo knowledge service: the tool list is answered from your own machine using captured definitions, and each call travels upstream, with the service's answer handed back exactly as it arrived.

Five read tools are exposed, the read side of a cited, versioned knowledge service. Retrieve candidate passages from public datasets and check them before citing; list the public datasets available; read a dataset's document-version timeline including deleted documents; list its pending revisions; and search a directory of official, vendor-run remote MCP servers for endpoint, sign-in type, documentation and known tools.

This is a labelled subset. Three captured tools are deliberately absent: a tool that submits new or changed document content into a dataset owner's approval queue, the owner's credentialed approve/reject action, and a tool that registers a server in the directory and returns an owner key. None of those are reads, and none are offered here at the registry, MCP or CLI level.

## The tools

- **`koskamo_retrieve`** — Retrieve candidate passages for a `query` from Koskamo datasets. Optionally narrow to one `dataset` and set `top_k` (1 to 12). Check that a passage answers the question before citing it; scores are not confidence probabilities.
- **`koskamo_list_datasets`** — List the public Koskamo datasets an agent may retrieve from. Takes no arguments.
- **`koskamo_get_history`** — Get the document version timeline for a public `dataset`: every document, including deleted ones, with the version history produced by approved revisions.
- **`koskamo_list_revisions`** — List pending revisions for a `dataset`.
- **`koskamo_find_mcp_server`** — Find official, vendor-run remote MCP servers in the Koskamo directory. Every listed endpoint passed a recent live check. Filter by free-text `query`, by `category`, or by `auth` sign-in type. All filters are optional.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/citekeep mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "citekeep": {
      "command": "npx",
      "args": ["-y", "@reneturcios/citekeep", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/citekeep
docker run --rm ghcr.io/cloudcorprecords/citekeep koskamo_list_datasets '{}'
```

## CLI

A single binary covers both the command line and the MCP server. Every tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
citekeep koskamo_retrieve '{"query":"What does the dataset say about X?"}'
citekeep koskamo_list_datasets '{}'
citekeep koskamo_get_history '{"dataset":"my-dataset"}'
citekeep koskamo_list_revisions '{"dataset":"my-dataset"}'
citekeep koskamo_find_mcp_server '{"query":"documentation"}'
citekeep --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse.

## Configuration

- `KOSKAMO_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://koskamo.com/api/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Koskamo registry record lists no headers for its remote, so citekeep never attaches an authentication header — every call goes upstream keyless.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `citekeep error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, citekeep repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, asserts the three omitted tools are absent at registry, MCP and CLI level, walks the session handshake and its reuse, proves no `Authorization` header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
