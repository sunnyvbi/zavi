
import type { Request, Response } from "express";
import { verifyBearer } from "@/services/auth/jwt";
import { readOwnMember } from "@/services/humans/store";
import { publicMemberView } from "@/services/humans/view";
import { HumanError } from "@/services/humans/contract";

function sendHumanError(res: Response, e: unknown): void {
  if (e instanceof HumanError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[human] unexpected failure: ${(e as Error)?.message ?? e}`);
  res.status(500).json({ error: { code: "human_unavailable", message: "Creator accounts are temporarily unavailable." } });
}

export async function humanMe(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return;
  }
  try {
    const member = await readOwnMember(verified.user_id);
    if (!member) {
      res.json({ applied: false, member: null });
      return;
    }
    res.json({ applied: true, member: await publicMemberView(member) });
  } catch (e) {
    sendHumanError(res, e);
  }
}
