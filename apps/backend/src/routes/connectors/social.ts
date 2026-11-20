
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  setSocialConnection,
  type SocialPlatform,
} from "@/services/sandbox/browser-mcp/social-connections";
import { isSocialPublishEnabled } from "@/agents/social/social-publish-flag";

const connectBodySchema = z.object({
  platform: z.enum(["linkedin", "instagram", "tiktok"]),
  handle: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

const disconnectBodySchema = z.object({
  platform: z.enum(["linkedin", "instagram", "tiktok"]),
  handle: z.string().min(1),
});

export async function socialList(req: Request, res: Response): Promise<void> {
  if (!(await isSocialPublishEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { data, error } = await serviceClient()
    .from("social_connected_accounts")
    .select("platform, handle, status")
    .eq("tenant_id", auth.tenant_id)
    .eq("owner_user_id", auth.user_id)
    .order("connected_at", { ascending: true });
  if (error) {
    console.error("social_list_failed", {
      tenant_id: auth.tenant_id,
      error_code: error.code,
    });
    res.status(500).json({ error: { code: "social_list_failed" } });
    return;
  }

  res.json({ connections: data ?? [] });
}

export async function socialConnect(req: Request, res: Response): Promise<void> {
  if (!(await isSocialPublishEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = connectBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    });
    return;
  }

  const { platform, handle, username, password } = parsed.data;

  try {
    await setSocialConnection({
      tenant_id: auth.tenant_id,
      platform: platform as SocialPlatform,
      handle,
      username,
      password,
      owner_user_id: auth.user_id,
    });
  } catch (err) {
    console.error("social_connect_failed", {
      tenant_id: auth.tenant_id,
      platform,
      error_code: (err as { code?: string })?.code ?? "unknown",
    });
    res.status(500).json({
      error: {
        code: "social_connect_failed",
        message: "Failed to save social connection. Check server logs.",
      },
    });
    return;
  }

  res.json({ ok: true, platform, handle });
}

export async function socialDisconnect(req: Request, res: Response): Promise<void> {
  if (!(await isSocialPublishEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = disconnectBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    });
    return;
  }

  const { platform, handle } = parsed.data;

  const { data: ownedRow } = await serviceClient()
    .from("social_connected_accounts")
    .select("id")
    .eq("tenant_id", auth.tenant_id)
    .eq("platform", platform)
    .eq("handle", handle)
    .eq("owner_user_id", auth.user_id)
    .maybeSingle();
  if (!ownedRow) {
    res.status(404).json({ error: { code: "connection_not_found" } });
    return;
  }

  const { error } = await serviceClient().rpc("clear_social_connection", {
    p_tenant_id: auth.tenant_id,
    p_platform: platform,
    p_handle: handle,
  });

  if (error) {
    console.error("social_disconnect_failed", {
      tenant_id: auth.tenant_id,
      platform,
      error_code: error.code,
    });
    res.status(500).json({
      error: {
        code: "social_disconnect_failed",
        message: "Failed to disconnect social account. Check server logs.",
      },
    });
    return;
  }

  res.json({ ok: true, platform, handle });
}
