import { asTenantId, tenantClient } from "@/services/tenant-client";

export type ConnectorEvent = {
  tenant_id: string;
  slug: string;
  action: "connect" | "disconnect";
  actor_user_id: string;
  via: string;
};

const CLAIM_WINDOW_MS = 2 * 60_000;

export async function recordConnectorEvent(e: ConnectorEvent, now: Date = new Date()): Promise<void> {
  try {
    const db = tenantClient(asTenantId(e.tenant_id));
    const via = e.via.slice(0, 60);
    const { data, error } = await db.from("connector_events").select("id, meta")
      .eq("tenant_id", e.tenant_id).eq("slug", e.slug).eq("action", e.action)
      .is("actor_user_id", null).gte("created_at", new Date(now.getTime() - CLAIM_WINDOW_MS).toISOString())
      .order("id", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const row = (data as Array<{ id: number; meta: Record<string, unknown> | null }> | null)?.[0];
    if (row) {
      const { error: upErr } = await db.from("connector_events")
        .update({ actor_user_id: e.actor_user_id, meta: { ...(row.meta ?? {}), via } })
        .eq("id", row.id).is("actor_user_id", null);
      if (upErr) throw new Error(upErr.message);
      return;
    }
    const { error: insErr } = await db.from("connector_events").insert({
      tenant_id: e.tenant_id, slug: e.slug, action: e.action, actor_user_id: e.actor_user_id, meta: { via },
    });
    if (insErr) throw new Error(insErr.message);
  } catch (err) {
    console.warn("connector_event_not_recorded", { slug: e.slug, action: e.action, tenant_id: e.tenant_id, message: (err as Error).message });
  }
}

export async function claimConnectorEvents(c: {
  tenant_id: string;
  actor_user_id: string;
  action: "connect" | "disconnect";
  since: Date;
}): Promise<void> {
  try {
    const { error } = await tenantClient(asTenantId(c.tenant_id)).from("connector_events")
      .update({ actor_user_id: c.actor_user_id })
      .eq("tenant_id", c.tenant_id).eq("action", c.action)
      .is("actor_user_id", null).gte("created_at", c.since.toISOString());
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn("connector_event_actor_not_claimed", { action: c.action, tenant_id: c.tenant_id, message: (err as Error).message });
  }
}

const CLAIM_SKEW_MS = 5_000;

export function disconnectActorMiddleware(
  req: { method: string; path: string; auth?: { user_id?: string; tenant_id?: string } },
  res: { statusCode: number; on: (ev: "finish", cb: () => void) => unknown },
  next: () => void,
): void {
  if (req.method === "POST" && /^\/api\/connectors\/.+\/disconnect$/.test(req.path)) {
    const since = new Date(Date.now() - CLAIM_SKEW_MS);
    res.on("finish", () => {
      const a = req.auth;
      if (res.statusCode < 300 && a?.user_id && a.tenant_id) {
        void claimConnectorEvents({ tenant_id: a.tenant_id, actor_user_id: a.user_id, action: "disconnect", since });
      }
    });
  }
  next();
}
