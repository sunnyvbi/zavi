
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertStreamableUrlAllowed, redactSecrets } from "@/services/mcp/streamable-guards";

export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
const PROBE_TIMEOUT_MS = 30_000;

export type HiggsfieldProbeResult =
  | { ok: true; balance: string }
  | { ok: false; error: string };

export async function probeHiggsfield(accessToken: string): Promise<HiggsfieldProbeResult> {
  if (!accessToken || accessToken.length < 8) {
    return { ok: false, error: "access_token missing or too short" };
  }
  const url = assertStreamableUrlAllowed(HIGGSFIELD_MCP_URL);

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "praxis", version: "0.1.0" });
  try {
    await client.connect(transport);
    const res = await client.callTool(
      { name: "balance", arguments: {} },
      undefined,
      { timeout: PROBE_TIMEOUT_MS },
    );
    const isErr = (res as { isError?: boolean }).isError === true;
    const text = balanceText((res as { content?: unknown }).content);
    if (isErr) return { ok: false, error: redactSecrets(text) || "balance call returned an error" };
    return { ok: true, balance: redactSecrets(text) };
  } catch (e) {
    return { ok: false, error: redactSecrets((e as Error).message) };
  } finally {
    try {
      await client.close();
    } catch {
    }
  }
}

function balanceText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const parts: string[] = [];
  for (const item of content as Array<{ type?: string; text?: string }>) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n").slice(0, 2000);
}
