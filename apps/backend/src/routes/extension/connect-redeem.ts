
import type { Request, Response } from "express";
import { z } from "zod";
import { extensionAuthCodeClient } from "@/services/tenant-client";
import { anonClient } from "@/services/supabase";
import { hashCode } from "./connect-start";

const Body = z.object({
  code: z.string().min(1).max(512),
});

const CODE_INVALID = {
  error: { code: "code_invalid", message: "That sign-in link is no longer valid." },
} as const;
const CONNECT_FAILED = {
  error: { code: "connect_failed", message: "Sign-in didn't complete. Try again." },
} as const;

export async function extensionConnectRedeem(req: Request, res: Response): Promise<void> {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(CODE_INVALID);
    return;
  }

  const sb = extensionAuthCodeClient(
    "Chrome-extension sign-in handoff: consume a single-use code and mint the session it stands for.",
  );

  const now = new Date().toISOString();
  const { data: row, error: consumeErr } = await sb
    .from("extension_auth_codes")
    .update({ used_at: now })
    .eq("code_hash", hashCode(parsed.data.code))
    .is("used_at", null)
    .gt("expires_at", now)
    .select("user_id")
    .maybeSingle<{ user_id: string }>();

  if (consumeErr) {
    res.status(502).json(CONNECT_FAILED);
    return;
  }
  if (!row?.user_id) {
    res.status(400).json(CODE_INVALID);
    return;
  }
  const userId = row.user_id;

  const { data: userData, error: userErr } = await sb.auth.admin.getUserById(userId);
  const email = userData?.user?.email;
  if (userErr || !email) {
    fail("resolve");
    res.status(502).json(CONNECT_FAILED);
    return;
  }

  const link = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) {
    fail("mint");
    res.status(502).json(CONNECT_FAILED);
    return;
  }

  const { data: verified, error: verifyErr } = await anonClient().auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  const session = verified?.session;
  if (verifyErr || !session?.access_token || !session.refresh_token) {
    fail("verify");
    res.status(502).json(CONNECT_FAILED);
    return;
  }

  if (session.user?.id !== userId) {
    fail("identity");
    res.status(502).json(CONNECT_FAILED);
    return;
  }

  res.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
  });
}

function fail(stage: "resolve" | "mint" | "verify" | "identity"): void {
  // eslint-disable-next-line no-console
  console.error("[extension/connect/redeem] failed", { stage });
}
