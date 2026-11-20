
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { FIGMA_VAULT_KEYS } from "./keys";

const REQUEST_TIMEOUT_MS = 30_000;
const FIGMA_API_BASE = "https://api.figma.com";

export type FigmaCreds = { api_key: string };

export async function figmaCreds(tenant_id: string): Promise<FigmaCreds> {
  const apiKey = await getSecret(tenant_id, FIGMA_VAULT_KEYS.api_key);

  if (!apiKey) {
    throw new ExpectedToolError(
      "figma_not_connected",
      "Figma is not connected for this workspace. The operator connects it at Settings → Connectors → Figma by pasting a personal access token. Until then, design questions cannot be answered from Figma.",
      {
        next_step: "operator_action",
        unblockers: ["Connect Figma at Settings → Connectors"],
      },
    );
  }

  return { api_key: apiKey };
}

export async function figmaGet(tenant_id: string, path: string): Promise<unknown> {
  const { api_key } = await figmaCreds(tenant_id);
  const url = `${FIGMA_API_BASE}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "X-Figma-Token": api_key },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    throw new ExpectedToolError(
      "figma_unreachable",
      "Figma did not respond within 30s. Retry, or check status.figma.com.",
      { next_step: "retry" },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("figma_request_failed", { tenant_id, status: res.status, path });

    if (res.status === 401 || res.status === 403) {
      throw new ExpectedToolError(
        "figma_key_rejected",
        "Figma rejected the stored personal access token (401/403). It was revoked, expired, or lacks a required scope. Reconnect Figma at Settings → Connectors.",
        {
          next_step: "operator_action",
          unblockers: ["Reconnect Figma with a token scoped file_content:read + projects:read"],
        },
      );
    }
    if (res.status === 404) {
      throw new ExpectedToolError(
        "figma_not_found",
        "Figma returned 404 for that id. Check the team, project, or file id.",
        { next_step: "revise_input" },
      );
    }
    if (res.status === 429) {
      throw new ExpectedToolError(
        "figma_rate_limited",
        "Figma is rate-limiting this token right now. Wait a minute and retry.",
        { next_step: "retry" },
      );
    }
    throw new ExpectedToolError(
      "figma_request_failed",
      `Figma returned HTTP ${res.status} for this request.`,
      { next_step: "revise_input" },
    );
  }

  return res.json();
}
