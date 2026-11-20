
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import { POSTHOG_HOSTS, isPosthogRegion } from "@/services/tools/posthog/keys";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const PROBE_TIMEOUT_MS = 15_000;

const regionSchema = z.enum(["us", "eu"]);
const projectsSchema = z.object({ api_key: z.string().min(10), region: regionSchema });
const connectSchema = projectsSchema.extend({ project_id: z.string().regex(/^\d+$/) });

type Project = { id: string; name: string };

async function listProjects(host: string, apiKey: string): Promise<Project[] | "unauthorized" | "error"> {
  const get = async (path: string): Promise<unknown | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${host}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.status === 401) return "unauthorized";
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const toProjects = (rows: unknown[]): Project[] =>
    rows
      .map((t) => t as { id?: unknown; name?: unknown })
      .filter((t) => t.id !== undefined)
      .map((t) => ({ id: String(t.id), name: String(t.name ?? `Project ${String(t.id)}`) }));

  const orgProjects = await get("/api/organizations/@current/projects/");
  if (orgProjects === "unauthorized") return "unauthorized";
  const results = (orgProjects as { results?: unknown } | null)?.results;
  if (Array.isArray(results) && results.length > 0) return toProjects(results);

  const me = await get("/api/users/@me/");
  if (me === "unauthorized") return "unauthorized";
  const teams = (me as { teams?: unknown } | null)?.teams;
  if (Array.isArray(teams)) return toProjects(teams);
  if (Array.isArray(results)) return [];
  return "error";
}

export async function posthogProjects(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = projectsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const { api_key, region } = parsed.data;
  const projects = await listProjects(POSTHOG_HOSTS[region], api_key);

  if (projects === "unauthorized") {
    console.error("posthog_projects_key_rejected", { tenant_id: auth.tenant_id, region });
    res.status(400).json({
      error: {
        code: "posthog_key_invalid",
        message:
          "PostHog rejected this key. Use a personal API key (Settings → Personal API keys) scoped with Query Read and Project Read.",
      },
    });
    return;
  }
  if (projects === "error" || projects.length === 0) {
    console.error("posthog_projects_unavailable", { tenant_id: auth.tenant_id, region });
    res.status(400).json({
      error: {
        code: "posthog_no_projects",
        message:
          "That key is valid but no projects were visible. Check you picked the right region (US vs EU) and that the key has Project Read scope.",
      },
    });
    return;
  }

  res.status(200).json({ projects });
}

export async function posthogConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const { api_key, region, project_id } = parsed.data;
  if (!isPosthogRegion(region)) {
    res.status(400).json({ error: { code: "invalid_body", message: "region must be us or eu" } });
    return;
  }

  const projects = await listProjects(POSTHOG_HOSTS[region], api_key);
  if (projects === "unauthorized" || projects === "error") {
    console.error("posthog_connect_validate_failed", { tenant_id: auth.tenant_id, region });
    res.status(400).json({
      error: {
        code: "posthog_key_invalid",
        message: "PostHog rejected this key. Use a personal API key with Query Read and Project Read scopes.",
      },
    });
    return;
  }
  if (!projects.some((p) => p.id === project_id)) {
    res.status(400).json({
      error: { code: "posthog_project_not_allowed", message: "That project is not reachable with this key." },
    });
    return;
  }

  const { error } = await tenantRpc(auth.tenant_id, "set_posthog_connection", {
    p_api_key: api_key,
    p_project_id: project_id,
    p_region: region,
  });

  if (error) {
    console.error("posthog_connect_failed", { tenant_id: auth.tenant_id, error_code: error.code });
    res.status(500).json({
      error: { code: "posthog_connect_failed", message: "Could not save the PostHog connection. Try again." },
    });
    return;
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "posthog" } });
  res.status(200).json({ ok: true, project_id, region });
}
