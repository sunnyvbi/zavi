
import type { Request, Response } from "express";
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { gateRaise } from "./fundraising-raise-gate";

function bad(res: Response, e: unknown): void {
  res
    .status(400)
    .json({ error: { code: "validation", message: (e as Error).message } });
}
function boom(res: Response, e: unknown): void {
  res
    .status(500)
    .json({ error: { code: "internal", message: (e as Error).message } });
}

const CreateIntroBody = z.object({
  target_firm: z.string().min(1).max(300),
  target_person: z.string().max(300).optional(),
  path: z.string().max(2000).optional(),
  draft_text: z.string().max(8000).optional(),
});

export async function fundraisingCreateRaiseIntro(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof CreateIntroBody>;
  try {
    body = CreateIntroBody.parse(req.body ?? {});
  } catch (e) {
    return bad(res, e);
  }
  const gated = await gateRaise(req, res);
  if (!gated) return;

  try {
    const { data, error } = await serviceClient().rpc(
      "fundraising_create_raise_intro",
      {
        p_tenant_id: gated.tenant_id,
        p_target_firm: body.target_firm,
        p_target_person: body.target_person ?? null,
        p_path: body.path ?? null,
        p_draft_text: body.draft_text ?? null,
      },
    );
    if (error) throw error;
    res.status(200).json({ ok: true, id: data as string });
  } catch (e) {
    boom(res, e);
  }
}

const IntroSentBody = z.object({ id: z.string().uuid() });

export async function fundraisingMarkIntroSent(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof IntroSentBody>;
  try {
    body = IntroSentBody.parse(req.body ?? {});
  } catch (e) {
    return bad(res, e);
  }
  const gated = await gateRaise(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc("fundraising_mark_intro_sent", {
      p_tenant_id: gated.tenant_id,
      p_id: body.id,
    });
    if (error) throw error;
    res.status(200).json({ ok: true, id: body.id, status: "sent" });
  } catch (e) {
    boom(res, e);
  }
}

const CreateMeetingBody = z.object({
  investor_ref: z.string().min(1).max(300),
  investor_id: z.string().uuid().optional(),
  scheduled_for: z.string().datetime().optional(),
});

export async function fundraisingCreateRaiseMeeting(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof CreateMeetingBody>;
  try {
    body = CreateMeetingBody.parse(req.body ?? {});
  } catch (e) {
    return bad(res, e);
  }
  const gated = await gateRaise(req, res);
  if (!gated) return;

  try {
    const { data, error } = await serviceClient().rpc(
      "fundraising_create_raise_meeting",
      {
        p_tenant_id: gated.tenant_id,
        p_investor_ref: body.investor_ref,
        p_investor_id: body.investor_id ?? null,
        p_scheduled_for: body.scheduled_for ?? null,
      },
    );
    if (error) throw error;
    res.status(200).json({ ok: true, id: data as string });
  } catch (e) {
    boom(res, e);
  }
}

const MeetingPrepBody = z.object({
  id: z.string().uuid(),
  prep: z.record(z.string(), z.unknown()),
});

export async function fundraisingSetMeetingPrep(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof MeetingPrepBody>;
  try {
    body = MeetingPrepBody.parse(req.body ?? {});
  } catch (e) {
    return bad(res, e);
  }
  const gated = await gateRaise(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc("fundraising_set_meeting_prep", {
      p_tenant_id: gated.tenant_id,
      p_id: body.id,
      p_prep: body.prep,
    });
    if (error) throw error;
    res.status(200).json({ ok: true, id: body.id });
  } catch (e) {
    boom(res, e);
  }
}

const MeetingDebriefBody = z.object({
  id: z.string().uuid(),
  outcome: z.enum(["soft_yes", "maybe", "pass"]),
  debrief: z.record(z.string(), z.unknown()).optional(),
});

export async function fundraisingDebriefRaiseMeeting(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof MeetingDebriefBody>;
  try {
    body = MeetingDebriefBody.parse(req.body ?? {});
  } catch (e) {
    return bad(res, e);
  }
  const gated = await gateRaise(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc(
      "fundraising_debrief_raise_meeting",
      {
        p_tenant_id: gated.tenant_id,
        p_id: body.id,
        p_outcome: body.outcome,
        p_debrief: body.debrief ?? null,
      },
    );
    if (error) throw error;
    res
      .status(200)
      .json({ ok: true, id: body.id, outcome: body.outcome, status: "done" });
  } catch (e) {
    boom(res, e);
  }
}
