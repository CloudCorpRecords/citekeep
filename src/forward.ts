/**
 * citekeep core: a forwarding client for the hosted
 * Koskamo cited, versioned knowledge MCP server.
 *
 * No retrieval happens on this machine. tools/list is
 * answered from the literal definitions below, which
 * reproduce a live capture of the upstream server word
 * for word (name, title, description and inputSchema
 * exactly as captured). A tools/call travels upstream
 * over a streamable-HTTP JSON-RPC session: an
 * initialize POST, a notifications/initialized POST,
 * then the tools/call POST, carrying the
 * Mcp-Session-Id response header on later requests
 * when the upstream issues one. The session opens
 * lazily on the first forwarded call and is reused for
 * the client's lifetime.
 *
 * LABELLED SUBSET: 5 of the 8 captured tools are
 * registered. The kept surface is the read side:
 * passage retrieval over public datasets, the public
 * dataset list, a dataset's document-version timeline,
 * its pending-revision list, and a search of the
 * vendor's MCP-server directory. Omitted and absent:
 * koskamo_propose_revision (public-content submission
 * into an owner's approval queue),
 * koskamo_decide_revision (credentialed owner
 * approve/reject requiring an API key), and
 * koskamo_register_mcp_server (returns an owner key
 * once, i.e. minting, and can send a confirmation
 * e-mail).
 *
 * The endpoint is pinned to https://koskamo.com/api/mcp
 * and may be replaced with the KOSKAMO_MCP_URL
 * environment variable (that override is a labelled
 * reconstruction). The registry record declares NO
 * headers on the remote: no auth header is ever sent,
 * under any environment.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures become an isError result whose text begins
 * with `citekeep error:` (that rendering is a labelled
 * reconstruction). Replies may be plain JSON or SSE.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://koskamo.com/api/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

// TOOL_DEFS_GENERATED_START
export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "koskamo_retrieve",
    "title": "Retrieve cited passages",
    "description": "Retrieve candidate passages from Koskamo datasets. Check that the text answers the question before citing it. If none supports the question, report no supporting evidence. Scores are not confidence probabilities.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000,
          "description": "The question or search string"
        },
        "dataset": {
          "type": "string",
          "description": "Optional dataset id or slug. Defaults to all public datasets."
        },
        "top_k": {
          "type": "integer",
          "description": "Maximum number of candidate passages to retrieve",
          "minimum": 1,
          "maximum": 12
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "koskamo_list_datasets",
    "title": "List public datasets",
    "description": "List public Koskamo datasets an agent may retrieve from.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "koskamo_get_history",
    "title": "Get document history",
    "description": "Get the document version timeline for a public dataset: every document (including deleted ones) with the version history produced by approved revisions.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "dataset": {
          "type": "string",
          "description": "Dataset id or slug"
        }
      },
      "required": [
        "dataset"
      ]
    }
  },
  {
    "name": "koskamo_list_revisions",
    "title": "List pending revisions",
    "description": "List pending revisions for a dataset.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "dataset": {
          "type": "string",
        "description": "Identifier of the dataset",
        }
      },
      "required": [
        "dataset"
      ]
    }
  },
  {
    "name": "koskamo_find_mcp_server",
    "title": "Find an MCP server",
    "description": "Find official, vendor-run remote MCP servers in the Koskamo MCP directory. Every listed endpoint passed a recent live check; returns the endpoint URL, sign-in type, documentation link, and known tools.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "maxLength": 200,
          "description": "Words to match against name, operator, description, use cases, and tool names"
        },
        "category": {
          "type": "string",
          "enum": [
            "docs-reference",
            "developer-tools",
            "cloud-infrastructure",
            "data-analytics",
            "ai-ml",
            "commerce",
            "payments",
            "productivity",
            "project-management",
            "crm-marketing",
            "erp-supply-chain",
            "design"
          ],
          "description": "Optional category filter"
        },
        "auth": {
          "type": "string",
          "enum": [
            "none",
            "oauth-optional",
            "oauth",
            "api-key"
          ],
          "description": "Optional sign-in filter; none means usable without an account; oauth-optional means public tools work anonymously and account tools prompt OAuth sign-in"
        }
      }
    }
  }
];
// TOOL_DEFS_GENERATED_END

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

export const OMITTED_TOOL_NAMES = [
  "koskamo_propose_revision",
  "koskamo_decide_revision",
  "koskamo_register_mcp_server",
] as const;

/** Whether `name` belongs to the kept surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `citekeep error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

export class CitekeepClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).KOSKAMO_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "citekeep", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    return result;
  }
}

export function createClient(deps: ForwardDeps = {}): CitekeepClient {
  return new CitekeepClient(deps);
}

export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new CitekeepClient(deps).callTool(name, args);
}
