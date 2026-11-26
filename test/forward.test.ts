import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CitekeepClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  OMITTED_TOOL_NAMES,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type { FetchFn, FetchResponseLike, ToolDef, ToolResult } from "../src/types.js";

const FIXTURE_URL = new URL("../../../harness/fixtures/koskamo-tools-original.json", import.meta.url);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Ruling 1 (extended fleet-wide, Rene 2026-11-15): the registration
 * comparison strips `description` fields recursively on both sides, so
 * truthful parameter descriptions added under the ruling do not break
 * the deep-equal against the captured fixture; everything else is
 * compared exactly as before.
 */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const RETRIEVE = "koskamo_retrieve";
const LIST_DS = "koskamo_list_datasets";
const HISTORY = "koskamo_get_history";
const REVISIONS = "koskamo_list_revisions";
const FIND = "koskamo_find_mcp_server";
const ALL_TOOLS = [RETRIEVE, LIST_DS, HISTORY, REVISIONS, FIND];
const OMITTED = ["koskamo_propose_revision", "koskamo_decide_revision", "koskamo_register_mcp_server"];

const SAMPLE_RESULT = { content: [{ type: "text", text: "{\"passages\":[{\"text\":\"evidence\"}]}" }], structuredContent: { passages: [{ text: "evidence" }] } };
const SAMPLE_ARGS = { query: "What is the policy?" };

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown>; }
interface FakeOptions { callResult?: Record<string, unknown>; callBodyText?: string; callError?: Record<string, unknown>; callStatus?: number; initError?: Record<string, unknown>; throwOn?: "initialize" | "tools/call"; sessionId?: string | null; hangOnCall?: boolean; sse?: boolean; }

function makeResponse(status: number, bodyText: string, headers: Record<string, string> = {}): FetchResponseLike {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null }, text: async () => bodyText };
}
function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) { return makeResponse(status, JSON.stringify(payload), headers); }

function makeUpstream(options: FakeOptions = {}): { fetchFn: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) return jsonResponse(200, { jsonrpc: "2.0", id: body.id, error: options.initError });
      const headers: Record<string, string> = {};
      const sessionId = options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "koskamo", version: "1.0.0" } } }, headers);
    }
    if (method === "notifications/initialized") return makeResponse(202, "");
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) { if (signal.aborted) { reject(new Error("aborted")); return; } signal.addEventListener("abort", () => reject(new Error("aborted"))); }
        });
      }
      if (options.callBodyText !== undefined) return makeResponse(options.callStatus ?? 200, options.callBodyText);
      if (options.callError !== undefined) return jsonResponse(200, { jsonrpc: "2.0", id: body.id, error: options.callError });
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) return makeResponse(200, `event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new CitekeepClient({ fetchFn: upstream.fetchFn, env: {}, ...extra });
  return { client: c, calls: upstream.calls };
}
function textOf(result: ToolResult): string { const content = result.content as Array<{ type: string; text: string }>; return content[0].text; }
function methods(calls: Captured[]): string[] { return calls.map((c) => c.body.method as string); }
function schemaOf(tool: ToolDef): Record<string, any> { return tool.inputSchema as Record<string, any>; }
function defOf(name: string): ToolDef { const def = TOOL_DEFS.find((t) => t.name === name); assert.ok(def !== undefined, `missing tool def ${name}`); return def; }

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function runCli(args: string[]) { return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], { cwd: CLI_ROOT, encoding: "utf8", timeout: 30000 }); }

async function withMcpClient<T>(upstream: { fetchFn: FetchFn }, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "citekeep-test", version: "0.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await fn(client); } finally { await client.close(); await server.close(); }
}

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => { if (skipWithoutFixture(t)) return; assert.equal(fixture.tools.length, 5); assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools)); });
  it("serves the 5 tool names in fixture order", () => { assert.deepEqual(TOOL_NAMES, ALL_TOOLS); });
  it("carries exactly the fixture's keys on every tool (including title)", () => { for (const tool of TOOL_DEFS) { assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name", "title"]); } });
  it("carries titles verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(defOf(RETRIEVE).title, "Retrieve cited passages");
    assert.equal(defOf(LIST_DS).title, "List public datasets");
    assert.equal(defOf(HISTORY).title, "Get document history");
    assert.equal(defOf(REVISIONS).title, "List pending revisions");
    assert.equal(defOf(FIND).title, "Find an MCP server");
    for (let i = 0; i < TOOL_DEFS.length; i++) assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
  });
  it("carries descriptions verbatim", (t) => { if (skipWithoutFixture(t)) return; for (let i = 0; i < TOOL_DEFS.length; i++) assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description); assert.match(defOf(RETRIEVE).description, /Retrieve candidate passages/); assert.match(defOf(FIND).description, /vendor-run remote MCP servers/); });
  it("carries required exactly as captured", () => {
    assert.deepEqual(schemaOf(defOf(RETRIEVE)).required, ["query"]);
    assert.equal("required" in schemaOf(defOf(LIST_DS)), false);
    assert.deepEqual(schemaOf(defOf(HISTORY)).required, ["dataset"]);
    assert.deepEqual(schemaOf(defOf(REVISIONS)).required, ["dataset"]);
    assert.equal("required" in schemaOf(defOf(FIND)), false);
  });
  it("every inputSchema is type object", () => { for (const tool of TOOL_DEFS) assert.equal(schemaOf(tool).type, "object"); });
  it("carries every fixture property in order", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[i]).properties), Object.keys(schemaOf(fixture.tools[i]).properties));
    assert.deepEqual(Object.keys(schemaOf(defOf(RETRIEVE)).properties), ["query", "dataset", "top_k"]);
    assert.deepEqual(Object.keys(schemaOf(defOf(LIST_DS)).properties), []);
    assert.deepEqual(Object.keys(schemaOf(defOf(HISTORY)).properties), ["dataset"]);
    assert.deepEqual(Object.keys(schemaOf(defOf(REVISIONS)).properties), ["dataset"]);
    assert.deepEqual(Object.keys(schemaOf(defOf(FIND)).properties), ["query", "category", "auth"]);
  });
  it("retrieve query has minLength 1 maxLength 2000, top_k 1..12 integer", () => {
    const q = schemaOf(defOf(RETRIEVE)).properties.query; assert.equal(q.type, "string"); assert.equal(q.minLength, 1); assert.equal(q.maxLength, 2000);
    const tk = schemaOf(defOf(RETRIEVE)).properties.top_k; assert.equal(tk.type, "integer"); assert.equal(tk.minimum, 1); assert.equal(tk.maximum, 12);
  });
  it("find category enum and auth enum are verbatim", () => {
    assert.deepEqual(schemaOf(defOf(FIND)).properties.category.enum, ["docs-reference","developer-tools","cloud-infrastructure","data-analytics","ai-ml","commerce","payments","productivity","project-management","crm-marketing","erp-supply-chain","design"]);
    assert.deepEqual(schemaOf(defOf(FIND)).properties.auth.enum, ["none","oauth-optional","oauth","api-key"]);
    assert.equal(schemaOf(defOf(FIND)).properties.query.maxLength, 200);
  });
  it("list_datasets takes no properties", () => { assert.deepEqual(schemaOf(defOf(LIST_DS)).properties, {}); });
  it("isKnownTool recognises built tools and rejects others", () => { for (const n of ALL_TOOLS) assert.equal(isKnownTool(n), true); assert.equal(isKnownTool("koskamo_retrieve2"), false); assert.equal(isKnownTool(""), false); });
  it("MCP tools/list carries exactly fixture's 5 tools and no upstream call", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => (await client.listTools()).tools);
    assert.deepEqual(listed.map((t) => t.name), ALL_TOOLS);
    assert.deepEqual(stripDescriptions(listed), stripDescriptions(fixture.tools));
    assert.equal(upstream.calls.length, 0);
  });
});

describe("omitted tools are absent", () => {
  it("registry: TOOL_DEFS and TOOL_NAMES contain none of the omitted tools", () => {
    for (const n of OMITTED) { assert.equal(TOOL_NAMES.includes(n), false); assert.equal(TOOL_DEFS.some((t) => t.name === n), false); assert.equal(isKnownTool(n), false); }
    assert.deepEqual([...OMITTED_TOOL_NAMES], OMITTED);
  });
  it("MCP layer: handleCallTool rejects omitted tools with MethodNotFound, no network", async () => {
    for (const n of OMITTED) {
      const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
      await assert.rejects(() => handleCallTool(c, n, {}), (err: unknown) => err instanceof McpError && err.code === ErrorCode.MethodNotFound);
      assert.equal(upstream.calls.length, 0);
    }
  });
  it("MCP layer: tools/call for omitted tools via client is rejected, no upstream", async () => {
    for (const n of OMITTED) {
      const upstream = makeUpstream();
      await withMcpClient(upstream, async (client) => { await assert.rejects(() => client.callTool({ name: n, arguments: {} })); });
      assert.equal(upstream.calls.length, 0);
    }
  });
  it("MCP tools/list contains none of the omitted tools", async () => {
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => (await client.listTools()).tools);
    for (const n of OMITTED) assert.equal(listed.some((t) => t.name === n), false);
  });
  it("CLI: each omitted name exits 2 with usage", () => {
    for (const n of OMITTED) { const res = runCli([n, "{}"]); assert.equal(res.status, 2, n); assert.match(res.stderr, /Usage:/); }
  });
});

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(RETRIEVE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), ["initialize", "notifications/initialized", "tools/call"]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://koskamo.com/api/mcp");
    for (const call of calls) { assert.equal(call.headers["Content-Type"], "application/json"); assert.equal(call.headers["Accept"], "application/json, text/event-stream"); }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });
  it("sends clientInfo citekeep and pinned protocol version", async () => {
    const { client: c, calls } = stubClient(); await c.callTool(RETRIEVE, SAMPLE_ARGS);
    const p = calls[0].body.params as Record<string, unknown>;
    assert.equal(p.protocolVersion, PROTOCOL_VERSION); assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(p.capabilities, {}); assert.deepEqual(p.clientInfo, { name: "citekeep", version: VERSION });
  });
  it("reuses session on later calls", async () => {
    const { client: c, calls } = stubClient(); await c.callTool(RETRIEVE, SAMPLE_ARGS); await c.callTool(LIST_DS, {});
    assert.deepEqual(methods(calls), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  });
  it("sends no session header when upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null }); await c.callTool(RETRIEVE, SAMPLE_ARGS);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });
  it("honours KOSKAMO_MCP_URL env override", async () => {
    const upstream = makeUpstream(); const c = new CitekeepClient({ fetchFn: upstream.fetchFn, env: { KOSKAMO_MCP_URL: "https://staging.example.com/mcp" } });
    await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.ok(upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"));
  });
  it("honours explicit url override over env", async () => {
    const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: { KOSKAMO_MCP_URL: "https://env.example.com/mcp" }, url: "https://explicit.example.com/mcp" });
    await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.ok(upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"));
  });
  it("falls back to pinned endpoint when env blank", async () => {
    const upstream = makeUpstream(); const c = new CitekeepClient({ fetchFn: upstream.fetchFn, env: { KOSKAMO_MCP_URL: "   " } });
    await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

describe("no auth header is ever sent", () => {
  it("no Authorization with empty env", async () => { const { client: c, calls } = stubClient(); await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.ok(calls.every((call) => call.headers["Authorization"] === undefined)); });
  it("no Authorization even with API key style env vars", async () => {
    const upstream = makeUpstream(); const c = new CitekeepClient({ fetchFn: upstream.fetchFn, env: { KOSKAMO_API_KEY: "k", KNOWLEDGE_ADMIN_KEY: "admin", AUTHORIZATION: "Bearer x", API_KEY: "y" } });
    await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.ok(upstream.calls.every((call) => call.headers["Authorization"] === undefined)); assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });
  it("sends only Content-Type, Accept and session headers", async () => {
    const { client: c, calls } = stubClient(); await c.callTool(RETRIEVE, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), ["Accept", "Content-Type", "Mcp-Session-Id"]);
  });
});

describe("tools/call forwarding", () => {
  it("forwards retrieve verbatim", async () => { const { client: c, calls } = stubClient(); await c.callTool(RETRIEVE, SAMPLE_ARGS); const p = calls[2].body.params as Record<string, unknown>; assert.equal(p.name, RETRIEVE); assert.deepEqual(p.arguments, SAMPLE_ARGS); });
  it("forwards list_datasets with empty args", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); await c.callTool(LIST_DS, {}); const p = upstream.calls[2].body.params as Record<string, unknown>; assert.equal(p.name, LIST_DS); assert.deepEqual(p.arguments, {}); });
  it("forwards get_history with dataset", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); await c.callTool(HISTORY, { dataset: "ds1" }); const p = upstream.calls[2].body.params as Record<string, unknown>; assert.equal(p.name, HISTORY); assert.deepEqual(p.arguments, { dataset: "ds1" }); });
  it("forwards list_revisions with dataset", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); await c.callTool(REVISIONS, { dataset: "ds1" }); const p = upstream.calls[2].body.params as Record<string, unknown>; assert.equal(p.name, REVISIONS); assert.deepEqual(p.arguments, { dataset: "ds1" }); });
  it("forwards find_mcp_server with query/category/auth", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); const args = { query: "docs", category: "docs-reference", auth: "none" }; await c.callTool(FIND, args); const p = upstream.calls[2].body.params as Record<string, unknown>; assert.equal(p.name, FIND); assert.deepEqual(p.arguments, args); });
  it("passes upstream result verbatim including extra fields", async () => { const { client: c } = stubClient(); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.deepEqual(out, SAMPLE_RESULT); });
  it("passes upstream isError through untouched", async () => { const r = { content: [{ type: "text", text: "no evidence" }], isError: true }; const { client: c } = stubClient({ callResult: r }); assert.deepEqual(await c.callTool(RETRIEVE, SAMPLE_ARGS), r); });
  it("reads SSE-framed response", async () => { const { client: c } = stubClient({ sse: true }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.deepEqual(out, SAMPLE_RESULT); });
  it("one-shot callTool helper forwards correctly", async () => { const upstream = makeUpstream(); const out = await callTool(LIST_DS, {}, { fetchFn: upstream.fetchFn, env: {} }); assert.equal(out.isError, undefined); const p = upstream.calls[2].body.params as Record<string, unknown>; assert.equal(p.name, LIST_DS); });
});

describe("upstream failures surface as citekeep error text", () => {
  it("maps JSON-RPC error", async () => { const { client: c } = stubClient({ callError: { code: -32000, message: "retrieval failed" } }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.equal(out.isError, true); assert.equal(textOf(out), "citekeep error: retrieval failed"); });
  it("maps initialize error", async () => { const { client: c } = stubClient({ initError: { code: -32600, message: "bad initialize" } }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.equal(textOf(out), "citekeep error: bad initialize"); });
  it("maps unparseable to malformed", async () => { const { client: c } = stubClient({ callBodyText: "<html>oops</html>" }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.equal(textOf(out), "citekeep error: malformed response"); });
  it("maps no-result to malformed", async () => { const { client: c } = stubClient({ callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}' }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.equal(textOf(out), "citekeep error: malformed response"); });
  it("maps non-2xx to HTTP error", async () => { const { client: c } = stubClient({ callBodyText: "err", callStatus: 500 }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.equal(textOf(out), "citekeep error: HTTP 500"); });
  it("maps throwing fetch", async () => { const { client: c } = stubClient({ throwOn: "tools/call" }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.match(textOf(out), /^citekeep error: /); });
  it("maps throwing initialize", async () => { const { client: c } = stubClient({ throwOn: "initialize" }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.equal(textOf(out), "citekeep error: socket hang up"); });
  it("maps timeout", async () => { const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 }); const out = await c.callTool(RETRIEVE, SAMPLE_ARGS); assert.match(textOf(out), /^citekeep error: /); });
});

describe("parseRpcBody", () => {
  it("parses plain JSON matching id", () => { assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}', 7), { jsonrpc: "2.0", id: 7, result: { ok: true } }); });
  it("parses SSE", () => { assert.deepEqual(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n', 2), { jsonrpc: "2.0", id: 2, result: { ok: true } }); });
  it("picks matching id among SSE", () => { const b = 'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n'; assert.deepEqual(parseRpcBody(b, 2), { jsonrpc: "2.0", id: 2, result: { n: 2 } }); });
  it("ignores DONE", () => { assert.deepEqual(parseRpcBody('data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n', 4), { jsonrpc: "2.0", id: 4, result: { ok: true } }); });
  it("returns null for empty/unparseable", () => { assert.equal(parseRpcBody(""), null); assert.equal(parseRpcBody("not json"), null); assert.equal(parseRpcBody("[1,2,3]"), null); });
});

describe("MCP layer validation", () => {
  it("rejects unknown tool MethodNotFound no network", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); await assert.rejects(() => handleCallTool(c, "not_a_tool", {}), (err: unknown) => err instanceof McpError && err.code === ErrorCode.MethodNotFound); assert.equal(upstream.calls.length, 0); });
  it("rejects array args InvalidParams", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); await assert.rejects(() => handleCallTool(c, RETRIEVE, ["nope"]), (err: unknown) => err instanceof McpError && err.code === ErrorCode.InvalidParams); assert.equal(upstream.calls.length, 0); });
  it("rejects string args InvalidParams", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); await assert.rejects(() => handleCallTool(c, RETRIEVE, "x"), (err: unknown) => err instanceof McpError && err.code === ErrorCode.InvalidParams); assert.equal(upstream.calls.length, 0); });
  it("forwards valid retrieve through MCP layer", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); const out = await handleCallTool(c, RETRIEVE, SAMPLE_ARGS); assert.deepEqual(out, SAMPLE_RESULT); });
  it("treats omitted arguments as empty object", async () => { const upstream = makeUpstream(); const c = createClient({ fetchFn: upstream.fetchFn, env: {} }); const out = await handleCallTool(c, LIST_DS, undefined); assert.deepEqual(out, SAMPLE_RESULT); const p = upstream.calls[2].body.params as Record<string, unknown>; assert.deepEqual(p.arguments, {}); });
  it("MCP tools/call unknown rejected no upstream", async () => { const upstream = makeUpstream(); await withMcpClient(upstream, async (client) => { await assert.rejects(() => client.callTool({ name: "nope", arguments: {} })); }); assert.equal(upstream.calls.length, 0); });
});

describe("CLI", () => {
  it("--version prints 0.1.0", () => { const res = runCli(["--version"]); assert.equal(res.status, 0); assert.equal(res.stdout.trim(), "0.1.0"); assert.equal(res.stdout.trim(), VERSION); });
  it("-v prints 0.1.0", () => { const res = runCli(["-v"]); assert.equal(res.status, 0); assert.equal(res.stdout.trim(), "0.1.0"); });
  it("unknown command usage exit 2 lists kept tools", () => { const res = runCli(["not-a-tool"]); assert.equal(res.status, 2); assert.match(res.stderr, /Usage:/); assert.match(res.stderr, /koskamo_retrieve, koskamo_list_datasets, koskamo_get_history, koskamo_list_revisions, koskamo_find_mcp_server/); });
  it("usage does not list omitted tools as commands (stderr contains only kept list)", () => { const res = runCli(["not-a-tool"]); assert.equal(res.status, 2); assert.equal(res.stderr.includes("koskamo_propose_revision"), false); assert.equal(res.stderr.includes("koskamo_decide_revision"), false); assert.equal(res.stderr.includes("koskamo_register_mcp_server"), false); });
  it("no command usage exit 2", () => { const res = runCli([]); assert.equal(res.status, 2); assert.match(res.stderr, /Usage:/); });
  it("non-JSON argument exits 2", () => { const res = runCli([RETRIEVE, "not json"]); assert.equal(res.status, 2); });
  it("JSON array argument exits 2", () => { const res = runCli([RETRIEVE, "[]"]); assert.equal(res.status, 2); });
  it("extra arguments after tool exit 2", () => { const res = runCli([RETRIEVE, "{}", "extra"]); assert.equal(res.status, 2); });
  it("extra arguments after mcp exit 2", () => { const res = runCli(["mcp", "extra"]); assert.equal(res.status, 2); });
});
