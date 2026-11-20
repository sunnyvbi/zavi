
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { readConnectorList } from "@/services/connectors/metadata";
import { readAdReadFailures } from "@/services/connectors/ad-read-failures";

export async function connectorsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const [connectors, failed] = await Promise.all([
      readConnectorList(auth.tenant_id),
      readAdReadFailures(auth.tenant_id),
    ]);
    const withHealth = connectors.map((c) => {
      const since = failed.reconnect.get(c.slug)?.since;
      if (since) return { ...c, read_failed: true, read_failed_since: since };
      const slow = failed.slow.get(c.slug);
      return slow ? { ...c, read_slow: true, read_slow_since: slow } : c;
    });
    res.json({ tenant_id: auth.tenant_id, connectors: withHealth });
  } catch (e) {
    res.status(500).json({
      error: { code: "connectors_read_failed", message: (e as Error).message },
    });
  }
}
