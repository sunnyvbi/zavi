
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { track } from "@/services/analytics/mixpanel";
import { getBoolSetting } from "@/services/settings";
import { inngest } from "@/../workers/client";
import { emitTeamReportPingDue } from "@/services/team-notes/report-pings";
import {
  TeamNoteError, dismissNote, getSuggestionsOff, markOpened, markShown, sendNote, setSuggestionsOff,
  type OfferEvent,
} from "@/services/team-notes/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ShownBody = z.object({ via: z.enum(["strip", "flag"]).optional() }).strict();
const SendBody = z.object({ note: z.string().trim().min(1).max(1000), extra: z.string().max(2000).optional() }).strict();
const DismissBody = z.object({ stop: z.boolean().optional() }).strict();
const PrefsBody = z.object({ suggestions_off: z.boolean() }).strict();

type Authed = NonNullable<Awaited<ReturnType<typeof requireAuth>>>;

function messageId(req: Request, res: Response): string | null {
  const id = String(req.params.messageId ?? "");
  if (!UUID.test(id)) {
    res.status(404).json({ error: { code: "not_found", message: "That note is gone." } });
    return null;
  }
  return id;
}

function fail(res: Response, e: unknown): void {
  if (e instanceof TeamNoteError) {
    const status = e.code === "forbidden" ? 403 : e.code === "invalid" ? 400 : 500;
    res.status(status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.warn(`[team-notes] ${(e as Error).message}`);
  res.status(500).json({ error: { code: "failed", message: "Not sent, try again." } });
}

function emit(name: string, auth: Authed, mid: string, ev: OfferEvent): void {
  track(name, {
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    message_id: mid,
    signal: ev.signal ?? null,
    source: ev.source ?? null,
  });
}

export async function teamNoteShown(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = messageId(req, res);
  if (!id) return;
  const parsed = ShownBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid", message: "Bad request." } });
    return;
  }
  const via = parsed.data.via ?? "strip";
  try {
    if (!(await getBoolSetting("team_note_enabled", auth.tenant_id))) {
      res.status(200).json({ show: false, offer_stop: false });
      return;
    }
    const r = await markShown(auth.tenant_id, auth.user_id, id, via);
    if (r.show && r.first) {
      track("team_note_shown", {
        tenant_id: auth.tenant_id, user_id: auth.user_id, message_id: id,
        signal: r.signal ?? null, source: r.source ?? null, via,
      });
    }
    res.status(200).json({ show: r.show === true, offer_stop: r.offer_stop === true });
  } catch (e) {
    fail(res, e);
  }
}

export async function teamNoteSend(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = messageId(req, res);
  if (!id) return;
  const parsed = SendBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid", message: "The note must be 1-1000 characters." } });
    return;
  }
  try {
    const extra = parsed.data.extra?.trim() ? parsed.data.extra.trim() : null;
    const r = await sendNote(auth.tenant_id, auth.user_id, id, parsed.data.note, extra);
    if (r.status !== "sent") {
      res.status(r.status === "not_found" ? 404 : 409).json({ error: { code: r.status, message: "Not sent, try again." } });
      return;
    }
    if (r.first) {
      emit("team_note_sent", auth, id, r);
      emitTeamReportPingDue(r.ping_id, (e) => inngest.send(e));
    }
    res.status(200).json({ status: "sent", report_id: r.report_id });
  } catch (e) {
    fail(res, e);
  }
}

export async function teamNoteDismiss(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = messageId(req, res);
  if (!id) return;
  const parsed = DismissBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid", message: "Bad request." } });
    return;
  }
  try {
    const stop = parsed.data.stop === true;
    const r = await dismissNote(auth.tenant_id, auth.user_id, id, stop);
    if (r.status === "dismissed") emit(stop ? "team_note_stop_suggesting" : "team_note_dismissed", auth, id, r);
    res.status(200).json({ status: r.status });
  } catch (e) {
    fail(res, e);
  }
}

export async function teamNoteOpened(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = messageId(req, res);
  if (!id) return;
  try {
    const r = await markOpened(auth.tenant_id, auth.user_id, id);
    if (r.status === "opened") emit("team_note_see_note_opened", auth, id, r);
    res.status(204).end();
  } catch (e) {
    fail(res, e);
  }
}

export async function teamNotePrefsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.status(200).json({ suggestions_off: await getSuggestionsOff(auth.tenant_id, auth.user_id) });
  } catch (e) {
    fail(res, e);
  }
}

export async function teamNotePrefsPut(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = PrefsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid", message: "Bad request." } });
    return;
  }
  try {
    await setSuggestionsOff(auth.tenant_id, auth.user_id, parsed.data.suggestions_off);
    res.status(200).json({ suggestions_off: parsed.data.suggestions_off });
  } catch (e) {
    fail(res, e);
  }
}
