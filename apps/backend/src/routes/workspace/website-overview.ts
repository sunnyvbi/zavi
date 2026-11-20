
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import {
  getSetting,
  getStringSetting,
  getBoolSetting,
  setTenantSetting,
} from "@/services/settings";
import { cleanAppTitle, cleanAppDescription } from "../../services/workspace/appTextClean";
import { buildRequestFromObjective, buildSessionTitle } from "@/services/agents/build-sessions";
import { resolveAppForRequest, sendAppSelectionError, type RequestedApp } from "@/services/sites/app-identity";
import { isVisibleSite, siteDeployedUrl } from "@/services/sites/site-build-status";
import { loadLatestLegacyBuild, resolveLegacyAppDeployedUrl } from "@/services/sites/legacy-app";

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

const VISIBILITY_VALUES = ["public", "private", "unlisted"] as const;
type Visibility = (typeof VISIBILITY_VALUES)[number];
function isVisibility(v: unknown): v is Visibility {
  return typeof v === "string" && (VISIBILITY_VALUES as readonly string[]).includes(v);
}

type AppDetails = { name: string | null; description: string | null };

function appDetails(value: unknown): AppDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name: null, description: null };
  }
  const raw = value as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    description: typeof raw.description === "string" ? raw.description.trim() || null : null,
  };
}

function isEditableAppDetails(value: unknown): value is { name: string; description?: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.name === "string" &&
    raw.name.trim().length > 0 &&
    raw.name.trim().length <= 120 &&
    (raw.description === undefined || raw.description === null ||
      (typeof raw.description === "string" && raw.description.trim().length <= 500))
  );
}

type SupabaseLike = ReturnType<typeof serverClientFromBearer>;

async function sendSiteOverview(
  sb: SupabaseLike,
  tenantId: string,
  app: Extract<RequestedApp, { kind: "site" }>,
  res: Response,
): Promise<void> {
  const { site } = app;
  const rootId = site.root_conductor_run_id ?? app.run_id;
  let root: unknown = null;
  if (rootId) {
    const { data, error } = await sb
      .from("conductor_runs")
      .select("objective, status")
      .eq("tenant_id", tenantId)
      .eq("id", rootId)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: { code: "read_failed", message: error.message } });
      return;
    }
    root = data;
  }
  const objective = (root as { objective?: string | null } | null)?.objective ?? null;
  res.status(200).json({
    app: {
      name: cleanAppTitle(buildSessionTitle(objective)) ?? "Your site",
      description: cleanAppDescription(buildRequestFromObjective(objective)),
      created_at: site.created_at ?? null,
      deployed_url: isVisibleSite(site) ? siteDeployedUrl(site) : null,
      build_status: (root as { status?: string | null } | null)?.status ?? null,
    },
    visibility: null,
    badge_hidden: null,
    site: { id: site.id, hostname: site.hostname, status: site.status },
  });
}

export async function getWebsiteOverviewHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(bearerToken(req));

  let app: RequestedApp;
  try {
    app = await resolveAppForRequest(req, sb, auth.tenant_id);
  } catch (e) {
    sendAppSelectionError(res, e);
    return;
  }
  if (app.kind === "site") {
    await sendSiteOverview(sb, auth.tenant_id, app, res);
    return;
  }

  const { data: tenant, error: tenantErr } = await sb
    .from("tenants")
    .select("display_name, product_url, created_at")
    .eq("id", auth.tenant_id)
    .maybeSingle();
  if (tenantErr) {
    res.status(500).json({ error: { code: "read_failed", message: tenantErr.message } });
    return;
  }

  const build = await loadLatestLegacyBuild(sb, auth.tenant_id);

  const [visibility, badgeHidden, savedDetails] = await Promise.all([
    getStringSetting("website_app_visibility", auth.tenant_id),
    getBoolSetting("website_platform_badge_hidden", auth.tenant_id),
    getSetting("website_app_details", auth.tenant_id),
  ]);
  const details = appDetails(savedDetails);

  const deployedUrl = await resolveLegacyAppDeployedUrl(sb, auth.tenant_id, {
    productUrl: tenant?.product_url,
    build,
  });

  const objective =
    typeof build?.objective === "string" ? buildRequestFromObjective(build.objective) : "";

  res.status(200).json({
    app: {
      name: cleanAppTitle(details.name) ?? cleanAppTitle(tenant?.display_name) ?? "Your app",
      description: details.description === null ? cleanAppDescription(objective) : cleanAppDescription(details.description),
      created_at: build?.created_at ?? tenant?.created_at ?? null,
      deployed_url: deployedUrl,
      build_status: build?.status ?? null,
    },
    visibility: isVisibility(visibility) ? visibility : "public",
    badge_hidden: badgeHidden === true,
  });
}

export async function setWebsiteSettingsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const body = (req.body ?? {}) as {
    visibility?: unknown;
    badge_hidden?: unknown;
    app?: unknown;
  };

  if (body.visibility !== undefined && !isVisibility(body.visibility)) {
    res.status(400).json({
      error: {
        code: "invalid_visibility",
        message: `visibility must be one of ${VISIBILITY_VALUES.join(", ")}`,
      },
    });
    return;
  }
  if (body.badge_hidden !== undefined && typeof body.badge_hidden !== "boolean") {
    res.status(400).json({
      error: { code: "invalid_badge_hidden", message: "badge_hidden must be a boolean" },
    });
    return;
  }
  if (body.app !== undefined && !isEditableAppDetails(body.app)) {
    res.status(400).json({
      error: {
        code: "invalid_app_details",
        message: "app.name must be 1–120 characters and app.description must be at most 500 characters",
      },
    });
    return;
  }
  if (body.visibility === undefined && body.badge_hidden === undefined && body.app === undefined) {
    res.status(400).json({
      error: { code: "no_changes", message: "provide app, visibility and/or badge_hidden" },
    });
    return;
  }

  try {
    if (body.visibility !== undefined) {
      await setTenantSetting(
        auth.tenant_id,
        "website_app_visibility",
        body.visibility,
        auth.user_id,
      );
    }
    if (body.badge_hidden !== undefined) {
      await setTenantSetting(
        auth.tenant_id,
        "website_platform_badge_hidden",
        body.badge_hidden,
        auth.user_id,
      );
    }
    if (body.app !== undefined) {
      const app = body.app as { name: string; description?: string | null };
      await setTenantSetting(
        auth.tenant_id,
        "website_app_details",
        { name: app.name.trim(), description: app.description?.trim() || null },
        auth.user_id,
      );
    }
  } catch (e) {
    res.status(500).json({
      error: { code: "write_failed", message: (e as Error).message },
    });
    return;
  }

  const [visibility, badgeHidden, savedDetails] = await Promise.all([
    getStringSetting("website_app_visibility", auth.tenant_id),
    getBoolSetting("website_platform_badge_hidden", auth.tenant_id),
    getSetting("website_app_details", auth.tenant_id),
  ]);
  const details = appDetails(savedDetails);
  res.status(200).json({
    ok: true,
    visibility: isVisibility(visibility) ? visibility : "public",
    badge_hidden: badgeHidden === true,
    ...(body.app !== undefined
      ? {
          app: {
            name: cleanAppTitle(details.name) ?? "Your app",
            ...(details.description === null
              ? {}
              : { description: cleanAppDescription(details.description) }),
          },
        }
      : {}),
  });
}
