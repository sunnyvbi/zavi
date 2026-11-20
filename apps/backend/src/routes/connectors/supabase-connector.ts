
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import { SUPABASE_MANAGEMENT_API_BASE } from "@/services/tools/supabase-connector/keys";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const PROBE_TIMEOUT_MS = 15_000;

const projectsSchema = z.object({ access_token: z.string().trim().min(20) });
const connectSchema = projectsSchema.extend({ project_ref: z.string().trim().min(1).max(64) });

type Project = { ref: string; name: string; region: string; status: string };

async function listProjects(accessToken: string): Promise<Project[] | "unauthorized" | "error"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_MANAGEMENT_API_BASE}/projects`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status === 401 || res.status === 403) return "unauthorized";
    if (!res.ok) return "error";
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return "error";
    return body
      .map((p) => p as { ref?: unknown; name?: unknown; region?: unknown; status?: unknown })
      .filter((p) => typeof p.ref === "string")
      .map((p) => ({
        ref: String(p.ref),
        name: String(p.name ?? p.ref),
        region: String(p.region ?? "unknown"),
        status: String(p.status ?? "unknown"),
      }));
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

export async function supabaseProjects(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = projectsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const { access_token } = parsed.data;
  const projects = await listProjects(access_token);

  if (projects === "unauthorized") {
    console.error("supabase_projects_token_rejected", { tenant_id: auth.tenant_id });
    res.status(400).json({
      error: {
        code: "supabase_token_invalid",
        message:
          "Supabase rejected this token. Use a personal access token (Account → Access Tokens at supabase.com/dashboard/account/tokens).",
      },
    });
    return;
  }
  if (projects === "error" || projects.length === 0) {
    console.error("supabase_projects_unavailable", { tenant_id: auth.tenant_id });
    res.status(400).json({
      error: {
        code: "supabase_no_projects",
        message: "That token is valid but no projects were visible on the account.",
      },
    });
    return;
  }

  res.status(200).json({ projects });
}

export async function supabaseConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const { access_token, project_ref } = parsed.data;

  const projects = await listProjects(access_token);
  if (projects === "unauthorized" || projects === "error") {
    console.error("supabase_connect_validate_failed", { tenant_id: auth.tenant_id });
    res.status(400).json({
      error: {
        code: "supabase_token_invalid",
        message: "Supabase rejected this token. Use a valid personal access token.",
      },
    });
    return;
  }
  const project = projects.find((p) => p.ref === project_ref);
  if (!project) {
    res.status(400).json({
      error: { code: "supabase_project_not_allowed", message: "That project is not reachable with this token." },
    });
    return;
  }

  const { error } = await tenantRpc(auth.tenant_id, "set_supabase_connection", {
    p_access_token: access_token,
    p_project_ref: project_ref,
    p_project_name: project.name,
  });

  if (error) {
    console.error("supabase_connect_failed", { tenant_id: auth.tenant_id, error_code: error.code });
    res.status(500).json({
      error: { code: "supabase_connect_failed", message: "Could not save the Supabase connection. Try again." },
    });
    return;
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "supabase" } });
  res.status(200).json({ ok: true, project_ref, project_name: project.name });
}
