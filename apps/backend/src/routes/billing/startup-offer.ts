
import type { Request, Response } from "express";

export async function startupOfferCheckout(_req: Request, res: Response): Promise<void> {
  res.status(410).json({
    error: { code: "offer_retired", message: "The startup offer has ended. See the plans on the pricing page." },
  });
}
