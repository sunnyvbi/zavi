
import { Router, type Request, type Response } from "express";
import { RunAgentInputSchema } from "@ag-ui/core";
import { authMiddleware } from "@/services/auth/middleware";
import { getBoolSetting } from "@/services/settings";
import { runZaviAgent } from "@/services/copilotkit/zavi-agent";
import { UI_TOOL_NAMES } from "@/services/copilotkit/ui-tools";

export const COPILOTKIT_AGENT_ID = "zavi";
export const COPILOTKIT_DEFAULT_AGENT_SLUG = "chief-of-staff";

export async function copilotGate(req: Request, res: Response, next: () => void): Promise<void> {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } });
    return;
  }
  const on = await getBoolSetting("copilotkit_transport_enabled", auth.tenant_id).catch(() => false);
  if (!on) {
    res.status(404).json({ error: { code: "copilotkit_disabled", message: "CopilotKit transport is off for this workspace." } });
    return;
  }
  next();
}

export function copilotInfo(_req: Request, res: Response): void {
  res.json({
    version: "zavi-1",
    mode: "sse",
    audioFileTranscriptionEnabled: false,
    agents: {
      [COPILOTKIT_AGENT_ID]: {
        name: COPILOTKIT_AGENT_ID,
        className: "ZaviAgent",
        description: `Zavi growth agent. Frontend tools it may call: ${UI_TOOL_NAMES.join(", ")}.`,
      },
    },
    telemetryDisabled: true,
  });
}

function bearerOf(req: Request): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function copilotRun(baseUrl: () => string) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.params.agentId !== COPILOTKIT_AGENT_ID) {
      res.status(404).json({ error: { code: "unknown_agent", message: `no agent ${req.params.agentId}` } });
      return;
    }
    const parsed = RunAgentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "not a RunAgentInput" } });
      return;
    }
    const auth = req.auth!;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const abort = new AbortController();
    req.on("close", () => abort.abort());

    for await (const chunk of runZaviAgent(
      { fetch, baseUrl: baseUrl() },
      { input: parsed.data, bearer: bearerOf(req), tenantId: auth.tenant_id, defaultAgentSlug: COPILOTKIT_DEFAULT_AGENT_SLUG, signal: abort.signal },
    )) {
      if (abort.signal.aborted) break;
      res.write(chunk);
    }
    res.end();
  };
}

export function copilotConnect(req: Request, res: Response): void {
  if (req.params.agentId !== COPILOTKIT_AGENT_ID) {
    res.status(404).json({ error: { code: "unknown_agent", message: `no agent ${req.params.agentId}` } });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.end();
}

export function copilotStop(_req: Request, res: Response): void {
  res.status(204).end();
}

export function copilotkitRouter(baseUrl: () => string): Router {
  const r = Router();
  r.use(authMiddleware, copilotGate);
  r.get("/info", copilotInfo);
  r.post("/agent/:agentId/run", copilotRun(baseUrl));
  r.post("/agent/:agentId/connect", copilotConnect);
  r.post("/agent/:agentId/stop/:threadId", copilotStop);
  return r;
}
