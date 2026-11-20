
import type { Request, Response } from "express";
import { quiesce, unquiesce, isQuiesced } from "@/services/agents/inngest-drain";

export function internalQuiesce(_req: Request, res: Response): void {
  const already = isQuiesced();
  quiesce();
  res.status(200).json({ quiesced: true, already });
}

export function internalUnquiesce(_req: Request, res: Response): void {
  const was = isQuiesced();
  unquiesce();
  res.status(200).json({ quiesced: false, was });
}
