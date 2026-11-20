
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

export type AgentInboxAddress = {
  agent_slug: string;
  address: string;
  from_name: string | null;
};

export async function workspaceInboxAddresses(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("tenant_agent_email_identity")
    .select("agent_slug, reply_to_address, from_name")
    .eq("tenant_id", auth.tenant_id)
    .eq("status", "active")
    .order("agent_slug", { ascending: true });

  if (error) {
    res.status(500).json({
      error: { code: "inbox_addresses_query_failed", message: error.message },
    });
    return;
  }

  const addresses: AgentInboxAddress[] = (
    (data ?? []) as Array<{
      agent_slug: string;
      reply_to_address: string;
      from_name: string | null;
    }>
  ).map((r) => ({
    agent_slug: r.agent_slug,
    address: r.reply_to_address,
    from_name: r.from_name ?? null,
  }));

  res.json({ address: addresses[0]?.address ?? null, addresses });
}
