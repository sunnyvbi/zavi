
import type { Request, Response } from "express";
import { getDeployBlockingRuns } from "@/services/agents/inflight-runs";

export async function internalInflightRuns(
  _req: Request,
  res: Response,
): Promise<void> {
  const result = await getDeployBlockingRuns();
  res.status(200).json(result);
}
