
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import type { AuthedRequest } from "@/services/auth/middleware";
import { hasCurrentExtensionConsent } from "@/services/extension/consent";
import {
  claimNextOp,
  completeOp,
  createPanelSession,
  endPanelSession,
  touchPanelSession,
} from "@/services/extension/browser-ops";

const Uuid = z.string().uuid();

const CreateSessionBody = z.object({
  tab_id: z.number().int().nonnegative(),
});

const ResultBody = z.object({
  session_id: Uuid,
  run_id: Uuid,
  execution_token: Uuid,
  status: z.enum(["done", "failed"]),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
});

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Not found." } });
}

function serverError(res: Response): void {
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong." } });
}

async function gate(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (!(await hasCurrentExtensionConsent(auth.tenant_id, auth.user_id))) {
    res.status(403).json({
      error: {
        code: "consent_required",
        message:
          "Zavi needs your OK before it can work in this tab. Open the Zavi extension to turn it on.",
      },
    });
    return null;
  }
  return auth;
}

export async function postExtensionSession(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res);
  if (!auth) return;
  const body = CreateSessionBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_request", message: "tab_id is required." } });
    return;
  }
  try {
    const session_id = await createPanelSession(auth.tenant_id, auth.user_id, body.data.tab_id);
    res.status(201).json({ session_id });
  } catch {
    serverError(res);
  }
}

export async function postExtensionSessionHeartbeat(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.id);
  if (!id.success) return notFound(res);
  try {
    const ok = await touchPanelSession(id.data, auth.tenant_id, auth.user_id);
    if (!ok) return notFound(res);
    res.status(204).end();
  } catch {
    serverError(res);
  }
}

export async function deleteExtensionSession(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res);
  if (!auth) return;
  const id = Uuid.safeParse(req.params.id);
  if (!id.success) return notFound(res);
  try {
    const ok = await endPanelSession(id.data, auth.tenant_id, auth.user_id);
    if (!ok) return notFound(res);
    res.status(204).end();
  } catch {
    serverError(res);
  }
}

export async function getExtensionNextOp(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res);
  if (!auth) return;
  const session = Uuid.safeParse(req.query.session);
  if (!session.success) return notFound(res);

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    const got = await claimNextOp(auth.tenant_id, auth.user_id, session.data, {
      signal: ac.signal,
    });
    if (got.kind === "aborted") return;
    if (got.kind === "dead") return notFound(res);
    if (got.kind === "timeout") {
      res.status(204).end();
      return;
    }
    res.status(200).json({ op: got.op });
  } catch {
    if (!res.headersSent) serverError(res);
  }
}

export async function postExtensionOpResult(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res);
  if (!auth) return;
  const opId = Uuid.safeParse(req.params.id);
  if (!opId.success) return notFound(res);
  const body = ResultBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_request", message: "Invalid result." } });
    return;
  }
  try {
    const ok = await completeOp({
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      op_id: opId.data,
      session_id: body.data.session_id,
      run_id: body.data.run_id,
      execution_token: body.data.execution_token,
      status: body.data.status,
      result: body.data.result ?? null,
    });
    if (!ok) return notFound(res);
    res.status(204).end();
  } catch {
    serverError(res);
  }
}
