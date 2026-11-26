# BUILD REPORT — citekeep

Clean-room rebuild of `com.koskamo/koskamo` v1.0.0
(remote-only MCP server at `https://koskamo.com/api/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/citekeep`
0.1.0, registry name `io.github.CloudCorpRecords/citekeep`.

## Surface built

**LABELLED SUBSET: 5 of the 8 captured tools built**, three omitted (below).

| Tool | Title (served) | Required fields as served |
|------|----------------|---------------------------|
| `koskamo_retrieve` | Retrieve cited passages | `query` |
| `koskamo_list_datasets` | List public datasets | *(none — no `required` key in the capture, served verbatim)* |
| `koskamo_get_history` | Get document history | `dataset` |
| `koskamo_list_revisions` | List pending revisions | `dataset` |
| `koskamo_find_mcp_server` | Find an MCP server | *(none — no `required` key in the capture, served verbatim)* |

Each served tool carries exactly the keys `name`,
`title`, `description`, `inputSchema` — the fixture
carries a `title` key per tool, so it is served verbatim.
Property shapes are served verbatim, including
`koskamo_retrieve`'s `query` (string, 1..2000 chars),
optional `dataset`, and `top_k` (integer 1..12);
`koskamo_find_mcp_server`'s optional `query` (max 200),
`category` enum (12 values) and `auth` enum
(`none`, `oauth-optional`, `oauth`, `api-key`).
The tool literals were generated programmatically from
`harness/fixtures/koskamo-tools-original.json` by the
script at `/tmp/laneb9-citekeep-scratch/gen2.py`
(parse + re-serialise, spliced into `src/forward.ts`
between the TOOL_DEFS_GENERATED markers) — never
retyped — and the generator's round-trip check confirmed
the spliced block parses back deep-equal to the
fixture's 5 tool objects, in order. Tools are
registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema`
handlers), not McpServer+zod.

The kept surface is the read side of a cited,
versioned knowledge service: passage retrieval over
public datasets with sourcing discipline, the public
dataset list, a public dataset's document-version
timeline, its pending-revision list (a read), and a
search of the vendor's MCP-server directory.
`koskamo_find_mcp_server` is an ordinary catalogue
search returning directory records — it dispatches
nothing and invokes nothing.

**OMITTED (asserted absent at registry, MCP-layer and CLI level in tests):**

- `koskamo_propose_revision` — submits new, changed or
  deleted document content into a public dataset owner's
  approval queue: a public-content submission.
- `koskamo_decide_revision` — the dataset owner's
  approve/reject action; its captured description states
  it requires the dataset owner's API key or
  KNOWLEDGE_ADMIN_KEY. A credentialed governance action.
- `koskamo_register_mcp_server` — registers a server in
  the directory and, once claim proof passes, returns an
  owner key once: a tool that returns a key is minting.
  Its e-mail method also sends a confirmation link.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools'
names, titles, descriptions, the `required` arrays
(`query`; none; `dataset`; `dataset`; none), and the
property shapes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://koskamo.com/api/mcp`.
- Env override `KOSKAMO_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header) is sent with an
  empty environment and with `KOSKAMO_API_KEY` /
  `KNOWLEDGE_ADMIN_KEY` / `AUTHORIZATION` / `API_KEY`
  variables present.
- Error rendering `citekeep error:` text for upstream failures
  — labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests, and no live call is
  claimed beyond the coordinator's tools/list capture.

## Deviations

**None.** No write-guard workaround was needed in this session:
the lockfile, `npm ci`, `tsc` build and test suite all ran
through the normal routes (direct `node_modules/.bin/tsc` /
`tsx` binaries), and `dist/` is the direct output of
`tsc` on the validated sources.

## Lockfile

Generated clean from birth (Route 3, clean dir, no
`node_modules`, no pre-existing lockfile):
`npm install --package-lock-only --ignore-scripts --offline`
→ success. Parses as JSON; `name` == `@reneturcios/citekeep`;
exactly **128** package entries; sha256
`a4705fc758dfec18471cf93b550a0f2e871a5cab78d3d91245d4c9cff9ca0850`.
`npm ci --ignore-scripts --offline` then succeeded and the
lockfile sha256 was re-verified **unchanged** afterwards.

## server.json

- Description exactly: "Cited, versioned knowledge: retrieve sourced passages from public datasets, with history." — **89 characters** (measured from the written file).
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/citekeep:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/citekeep"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/citekeep`
  and its smoke test asserts the server name `citekeep`.

## Verification (run 2026-10-28, builder session)

1. `npm install --package-lock-only --ignore-scripts --offline`
   → success; lockfile parses, name `@reneturcios/citekeep`,
   128 package entries (see Lockfile).
2. `npm ci --ignore-scripts --offline` → success; lockfile
   sha256 unchanged.
3. `tsc --noEmit` (direct `node_modules/.bin/tsc`) → exit 0.
4. `tsc` build → exit 0; `node dist/cli.js --version` → `0.1.0`.
5. Full suite (`tsx --test test/*.test.ts`, direct
   `node_modules/.bin/tsx`) → **65 tests,
   65 pass, 0 fail** (registration-integrity suite deep-equals
   the served tools/list against the fixture's 5 tools, in
   order, at both the registry level and through an
   in-memory-transport MCP `tools/list`, including per-tool
   title/required/property/enum detail; omission-absence
   assertions for all three omitted tools at registry,
   MCP-layer and CLI level; session handling/reuse, env
   override, no-Authorization-header assertions under every
   environment, verbatim argument forwarding for all 5 tools
   and result pass-through including upstream isError, SSE
   parsing, error rendering `citekeep error:`, MCP-layer
   validation, and CLI behaviour).
6. Parity (harness, tools-file mode):
   `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/koskamo-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/citekeep/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/citekeep/parity-out/`
   → **verdict PASS, parity 100.0** (5/5 identical, 0 missing,
   0 extra, no schema diffs). Output in `parity-out/`.
