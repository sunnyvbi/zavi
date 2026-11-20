
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSecret } from "@/services/secrets/vault";
import { getComposioApiKey, buildComposioMcpUrl } from "@/services/connectors/composio/api-key";
import { toolkitForTool, composioToolIsRead, shopifyGraphqlCallIsReadOnly } from "@/services/connectors/composio/write-classify";
import { shopifyToolDescriptionNote } from "@/services/connectors/shopify/writes";
import { getPipedreamCreds } from "@/services/connectors/pipedream/creds";
import { getPipedreamAccessToken } from "@/services/connectors/pipedream/token-provider";
import {
  isPipedreamServerId,
  isValidPipedreamServerId,
  anthropicNameFits,
} from "@/services/connectors/pipedream/slug";
import {
  assertStreamableUrlAllowed,
  encodeRemoteToolName,
  decodeRemoteToolName,
  redactSecrets,
} from "./streamable-guards";
import { isRemoteToolAllowed } from "./write-allowlist";
import { rememberComposioInputs } from "./composio-inputs";
import { isTiktokSpendWrite } from "@/services/connectors/tiktok-ads/held-schema";
import { isRawPinterestWrite } from "@/services/connectors/pinterest-composio/raw-write";
import {
  getCapabilityFailclosedMode,
  isTenantFailclosedBypassed,
  logCapabilityWouldBlock,
} from "./capability-failclosed";
import type { McpServerRow, McpTool, McpCallResult } from "./types";

const ADVERTISED_READ_TOOLS = new Map<string, Set<string>>();
const advKey = (tenant_id: string, server_id: string) => `${tenant_id}:${server_id}`;

export function advertisedReadToolNames(
  tenant_id: string,
  server_id: string,
): Set<string> | undefined {
  return ADVERTISED_READ_TOOLS.get(advKey(tenant_id, server_id));
}

const ADVERTISED_COMPOSIO_WRITES = new Map<string, Map<string, { destructive: boolean }>>();

export function advertisedComposioWriteTool(
  tenant_id: string,
  encoded: string,
): { destructive: boolean } | undefined {
  return ADVERTISED_COMPOSIO_WRITES.get(tenant_id)?.get(encoded);
}

export function _clearAdvertisedReadToolsForTests(): void {
  ADVERTISED_READ_TOOLS.clear();
  ADVERTISED_COMPOSIO_WRITES.clear();
}

export const COMPOSIO_WRITE_DESCRIPTION_PREFIX = "[Needs the founder's approval before it runs] ";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 256 * 1024;
const API_KEY_HEADER = process.env.COMPOSIO_API_KEY_HEADER?.trim() || "x-api-key";

type AuthDescriptor = { secretSuffix: string; headerName: string; valuePrefix: string };
const AUTH_DESCRIPTORS: Record<string, AuthDescriptor> = {
  higgsfield: { secretSuffix: "access_token", headerName: "Authorization", valuePrefix: "Bearer " },
};
function authDescriptorFor(server_id: string): AuthDescriptor {
  return AUTH_DESCRIPTORS[server_id] ?? { secretSuffix: "api_key", headerName: API_KEY_HEADER, valuePrefix: "" };
}

type RemoteTool = {
  name: string;
  description?: string;
  inputSchema?: { type?: string; [k: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
};

async function buildAuthHeaders(
  tenant_id: string,
  row: McpServerRow,
): Promise<Record<string, string>> {
  if (isPipedreamServerId(row.server_id)) {
    if (!isValidPipedreamServerId(row.server_id)) {
      throw new Error(`invalid_pipedream_server_id:${row.server_id}`);
    }
    const appSlug = row.args?.[0];
    if (!appSlug) {
      throw new Error(`pipedream row ${row.server_id} missing canonical app_slug (args[0])`);
    }
    const creds = getPipedreamCreds();
    const token = await getPipedreamAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      "x-pd-project-id": creds.projectId,
      "x-pd-environment": creds.environment,
      "x-pd-external-user-id": tenant_id,
      "x-pd-app-slug": appSlug,
    };
  }

  const auth = authDescriptorFor(row.server_id);
  let secret: string | null;
  if (row.server_id === "composio") {
    secret = getComposioApiKey();
  } else if (row.server_id === "higgsfield") {
    const { getConnectorToken } = await import("@/services/connectors/core/token");
    secret = await getConnectorToken(tenant_id, "higgsfield", "higgsfield.access_token");
  } else {
    secret = await getSecret(tenant_id, `${row.server_id}.${auth.secretSuffix}`);
  }
  if (!secret) {
    throw new Error(`${row.server_id}_not_connected`);
  }
  return { [auth.headerName]: `${auth.valuePrefix}${secret}` };
}

async function withClient<T>(
  tenant_id: string,
  row: McpServerRow,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const rawUrl = row.server_id === "composio" ? buildComposioMcpUrl(tenant_id) : row.url;
  if (!rawUrl) throw new Error(`streamable server ${row.server_id} has no url`);
  const url = assertStreamableUrlAllowed(rawUrl);

  const headers = await buildAuthHeaders(tenant_id, row);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  const client = new Client({ name: "praxis", version: "0.1.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
    }
  }
}

export async function listStreamableTools(
  tenant_id: string,
  row: McpServerRow,
  opts: { toolkits?: readonly string[] } = {},
): Promise<McpTool[]> {
  const isComposio = row.server_id === "composio";
  const toolkits = opts.toolkits ?? [];
  if (isComposio && toolkits.length === 0) {
    rememberAdvertisedTools(tenant_id, row.server_id, []);
    return [];
  }
  const res = await withClient(tenant_id, row, (c) =>
    c.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS }),
  );
  const tools = (res.tools ?? []) as RemoteTool[];
  const out: McpTool[] = [];
  const failclosedMode = getCapabilityFailclosedMode();
  const failclosedBypassed = isTenantFailclosedBypassed(tenant_id);
  for (const t of tools) {
    let isRead: boolean;
    if (isComposio) {
      const toolkit = await toolkitForTool(t.name, toolkits);
      if (!toolkit) continue;
      if (isTiktokSpendWrite(t.name, toolkit)) continue;
      if (isRawPinterestWrite(t.name, toolkit)) continue;
      isRead = composioToolIsRead(t.name, toolkit, t.annotations);
    } else {
      isRead = isRemoteToolAllowed(row.server_id, t.name, t.annotations, {
        mode: failclosedMode,
        bypassed: failclosedBypassed,
      });
      if (!isRead) continue;
      if (failclosedMode !== "enforce" || failclosedBypassed) {
        if (!isRemoteToolAllowed(row.server_id, t.name, t.annotations)) {
          logCapabilityWouldBlock({
            tenant_id,
            server_id: row.server_id,
            tool_name: t.name,
            gate: "advertise",
          });
        }
      }
    }
    const encoded = encodeRemoteToolName(t.name);
    if (!anthropicNameFits(row.server_id, encoded)) {
      console.warn(`[mcp/streamable] skip ${row.server_id}/${t.name}: anthropic name too long`);
      continue;
    }
    const schema =
      t.inputSchema && t.inputSchema.type === "object"
        ? (t.inputSchema as { type: "object"; [k: string]: unknown })
        : { type: "object" as const, properties: {} };
    const composioWrite = isComposio && !isRead;
    const described = `${t.description ?? t.name}${isComposio ? shopifyToolDescriptionNote(t.name) : ""}`;
    out.push({
      server_id: row.server_id,
      tool_name: encoded,
      description: composioWrite ? `${COMPOSIO_WRITE_DESCRIPTION_PREFIX}${described}` : described,
      input_schema: schema,
      annotations: t.annotations,
      ...(composioWrite ? { requires_approval: true } : {}),
    });
  }
  rememberAdvertisedTools(tenant_id, row.server_id, out);
  return out;
}

export function rememberAdvertisedTools(tenant_id: string, server_id: string, tools: readonly McpTool[]): void {
  if (server_id === "composio") rememberComposioInputs(tenant_id, tools);
  const reads = new Set<string>();
  const writes = new Map<string, { destructive: boolean }>();
  for (const t of tools) {
    if (server_id === "composio" && t.requires_approval === true) {
      writes.set(t.tool_name, { destructive: t.annotations?.destructiveHint === true });
    } else {
      reads.add(t.tool_name);
    }
  }
  ADVERTISED_READ_TOOLS.set(advKey(tenant_id, server_id), reads);
  if (server_id === "composio") ADVERTISED_COMPOSIO_WRITES.set(tenant_id, writes);
}

export async function callStreamableTool(
  tenant_id: string,
  row: McpServerRow,
  encoded_tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const realName = decodeRemoteToolName(encoded_tool_name);
  if (row.server_id === "composio" && realName.startsWith("SHOPIFY_GRAPH_QL_") && !shopifyGraphqlCallIsReadOnly(realName, args)) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_not_allowed",
        message: "This Shopify connection allows GraphQL reads only.",
      }),
      ms: 0,
    };
  }
  try {
    const res = await withClient(tenant_id, row, (c) =>
      c.callTool(
        { name: realName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS },
      ),
    );
    const text = redactSecrets(normalizeContent((res as { content?: unknown }).content));
    const isErr = (res as { isError?: boolean }).isError === true;
    return { ok: !isErr, is_error: isErr, content: text, ms: Date.now() - start };
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: redactSecrets(
        JSON.stringify({ error: "streamable_call_failed", message: (e as Error).message }),
      ),
      ms: Date.now() - start,
    };
  }
}

function normalizeContent(content: unknown): string {
  if (!Array.isArray(content)) return cap(JSON.stringify(content ?? null));
  const parts: string[] = [];
  for (const item of content as Array<{ type?: string; text?: string }>) {
    if (item?.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item?.type === "image") {
      parts.push("[image omitted]");
    } else if (item?.type === "resource") {
      parts.push("[resource omitted]");
    } else {
      parts.push(cap(JSON.stringify(item), 2048));
    }
  }
  return cap(parts.join("\n"));
}

function cap(s: string, max = MAX_RESULT_BYTES): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated ${s.length - max} bytes]`;
}
