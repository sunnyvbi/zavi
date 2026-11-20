import type { Request, Response } from "express";
import { recordClick } from "@/services/affiliates/store";

export async function postAffiliateClick(req: Request, res: Response): Promise<void> {
  const code = typeof (req.body as { code?: unknown } | undefined)?.code === "string" ? (req.body as { code: string }).code.trim().toLowerCase() : "";
  try {
    const id = await recordClick(code);
    res.set("Cache-Control", "no-store").json({ click_id: id });
  } catch (e) {
    console.error(`[affiliate] click failed: ${(e as Error).message?.slice(0, 200)}`);
    res.status(503).json({ click_id: null });
  }
}
