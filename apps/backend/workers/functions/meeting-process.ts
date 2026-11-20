
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBot, fetchTranscript, deleteBotMedia, transcriptToText } from "@/services/meetings/recall";
import { distillTranscript, defaultExpiry, type MeetingAtom } from "@/services/meetings/distill";
import { generateMinutes, type MeetingMinutes } from "@/services/meetings/minutes";
import { workspaceUrl } from "@/services/web-base";
import {
  sendMeetingSummaryEmail,
  renderMeetingSummary,
  sendDistillFailureOpsAlert,
  sendChooseDestinationEmail,
  sendRecapPostFailedEmail,
} from "@/services/meetings/summary-email";
import { planRecapDelivery, type RecapPlan } from "@/services/meetings/recap-destination";
import { writeMeetingAtomsToBrain } from "@/services/meetings/write-atoms";
import { notetakerEnabledByDefault } from "@/services/meetings/settings-defaults";
import { slackFetch } from "@/services/tools/slack/_client";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";

const MEETING_PROCESS_RETRIES = 2;

export const meetingProcessFn = inngest.createFunction(
  {
    id: "meeting-process",
    retries: MEETING_PROCESS_RETRIES,
    concurrency: [{ scope: "fn", key: "event.data.tenant_id", limit: 1 }],
    onFailure: async ({ event, error }) => {
      const id = (event.data.event.data as { meeting_bot_id?: string })?.meeting_bot_id;
      if (!id) return;
      const real = (error as Error)?.message?.slice(0, 500) || "processing failed (no error message)";
      await serviceClient()
        .from("meeting_bots")
        .update({ status: "failed", error: real, updated_at: new Date().toISOString() })
        .eq("id", id)
        .neq("status", "ingested")
        .neq("status", "cancelled");
    },
  },
  { event: "meeting.bot.status" },
  async ({ event, step, logger, attempt }) => {
    const meetingBotId = String(event.data.meeting_bot_id ?? "");
    if (!meetingBotId) return { skipped: "no_bot_id" };

    const svc = serviceClient();

    const bot = await step.run("claim", async () => {
      const { data, error } = await svc
        .from("meeting_bots")
        .select("id, tenant_id, provider_bot_id, status, scheduled_date, source, requested_by, slack_team_id, slack_channel_id, slack_thread_ts")
        .eq("id", meetingBotId)
        .maybeSingle();
      if (error) throw new Error(`bot read failed: ${error.message}`);
      if (!data || !data.provider_bot_id) return null;
      if (data.status === "ingested") return null;
      if (data.status === "cancelled") return null;
      const { data: claimed, error: claimErr } = await svc
        .from("meeting_bots")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("id", data.id)
        .neq("status", "cancelled")
        .select("id");
      if (!claimErr && (claimed ?? []).length === 0) return null;
      return data;
    });
    if (!bot) return { skipped: "already_ingested_or_missing" };

    const transcript = await step.run("transcript-text", async () => {
      const { data: saved, error: savedErr } = await svc
        .from("meeting_notes")
        .select("transcript, delete_after")
        .eq("bot_id", bot.id)
        .eq("tenant_id", bot.tenant_id as string)
        .maybeSingle();
      if (savedErr) logger.warn(`[meeting-process] saved transcript read failed bot=${bot.id}: ${savedErr.message}`);
      const savedText = typeof saved?.transcript === "string" ? saved.transcript : "";
      const savedLive = saved?.delete_after ? Date.parse(String(saved.delete_after)) > Date.now() : false;
      if (!savedErr && savedLive && savedText.trim().length > 0) return { text: savedText, from: "zavi" as const };
      const remote = await getBot(bot.provider_bot_id as string);
      if (!remote.transcript_download_url) {
        throw new Error("transcript not ready");
      }
      return { text: transcriptToText(await fetchTranscript(remote.transcript_download_url)), from: "recall" as const };
    });
    const transcriptText = transcript.text;

    if (transcriptText.trim().length === 0) {
      await step.run("mark-empty", async () => {
        await svc
          .from("meeting_bots")
          .update({ status: "ingested", atoms_count: 0, updated_at: new Date().toISOString() })
          .eq("id", bot.id)
          .neq("status", "cancelled");
        try {
          await deleteBotMedia(bot.provider_bot_id as string);
          await svc.from("meeting_bots").update({ media_deleted_at: new Date().toISOString() }).eq("id", bot.id).is("media_deleted_at", null);
        } catch (e) {
          logger.error(`[meeting-process] delete_media (empty) failed bot=${bot.provider_bot_id}: ${(e as Error).message}`);
        }
      });
      return { atoms: 0, empty: true };
    }

    const tenant_id = bot.tenant_id as string;
    const distillResult = await step.run("distill", async () => {
      const { data: tenant } = await svc
        .from("tenants")
        .select("name")
        .eq("id", tenant_id)
        .maybeSingle();
      try {
        const atoms = await distillTranscript(transcriptText, {
          tenant_name: tenant?.name ?? null,
          meeting_date: String(bot.scheduled_date),
        });
        return { ok: true as const, atoms };
      } catch (e) {
        return { ok: false as const, error: (e as Error)?.message?.slice(0, 500) || "distill failed" };
      }
    });
    const distillFailed = !distillResult.ok;
    const distillError = distillResult.ok ? null : distillResult.error;
    const atoms: MeetingAtom[] = distillResult.ok ? distillResult.atoms : [];

    const minutes: MeetingMinutes | null = await step.run("minutes", async () => {
      const { data: tenant } = await svc
        .from("tenants")
        .select("name")
        .eq("id", tenant_id)
        .maybeSingle();
      try {
        return await generateMinutes(transcriptText, {
          tenant_name: tenant?.name ?? null,
          meeting_date: String(bot.scheduled_date),
        });
      } catch {
        return null;
      }
    });

    const persisted = await step.run("persist", async () => {
      const { data: live, error: liveErr } = await svc.from("meeting_bots").select("status").eq("id", bot.id).maybeSingle();
      if (liveErr) throw new Error(`bot re-read failed: ${liveErr.message}`);
      if (live?.status === "cancelled") return { cancelled: true as const };

      const { count: existingAtoms, error: countErr } = await svc
        .from("meeting_atoms")
        .select("id", { count: "exact", head: true })
        .eq("bot_id", bot.id);
      if (countErr) throw new Error(`atoms dedup count failed: ${countErr.message}`);
      const alreadyPersisted = (existingAtoms ?? 0) > 0;

      const now = new Date();
      const rows = (atoms as MeetingAtom[]).map((a) => {
        const canonical = a.memory_class === "canonical";
        const expiry = defaultExpiry(a.memory_class, now);
        return {
          tenant_id: bot.tenant_id,
          bot_id: bot.id,
          atom_type: a.atom_type,
          title: a.title,
          body: a.body ?? "",
          owner: a.owner ?? null,
          due_date: a.due_date ?? null,
          expires_at: expiry ? expiry.toISOString() : null,
          confidence: a.confidence,
          memory_class: a.memory_class,
          status: canonical ? "pending_review" : "auto_stored",
          source_excerpt: a.source_excerpt ?? "",
        };
      });
      if (!alreadyPersisted && rows.length > 0) {
        const { error } = await svc.from("meeting_atoms").insert(rows);
        if (error) throw new Error(`atoms insert failed: ${error.message}`);
      }

      await svc
        .from("meeting_bots")
        .update({
          status: "ingested",
          atoms_count: alreadyPersisted ? (existingAtoms ?? 0) : rows.length,
          transcript_chars: transcriptText.length,
          error: distillFailed ? distillError : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", bot.id)
        .neq("status", "cancelled");
      return { cancelled: false as const };
    });
    if (persisted?.cancelled === true) return { skipped: "cancelled" };

    const savedFacts = await step.run("save-facts", async () => {
      const giveUp = (what: string) => {
        if ((attempt ?? 0) < MEETING_PROCESS_RETRIES) throw new Error(`save facts: ${what}`);
        logger.error(`[meeting-process] facts not saved bot=${bot.id}: ${what}`);
        return { saved: 0 };
      };
      const { data: live, error: liveErr } = await svc.from("meeting_bots").select("status").eq("id", bot.id).maybeSingle();
      if (liveErr) return giveUp(`bot re-read failed: ${liveErr.message}`);
      if (!live || live.status === "cancelled") return { saved: 0 };
      const { data: cards, error: cardErr } = await svc
        .from("decisions")
        .select("id")
        .eq("tenant_id", bot.tenant_id)
        .eq("decision_class", "notetaker.write_atoms")
        .eq("body->>meeting_bot_id", bot.id)
        .limit(1);
      if (cardErr) return giveUp(`card read failed: ${cardErr.message}`);
      if (cards && cards.length > 0) return { saved: 0 };
      const { data: pending, error } = await svc
        .from("meeting_atoms")
        .select("atom_type, title, body, owner, confidence, source_excerpt")
        .eq("tenant_id", bot.tenant_id)
        .eq("bot_id", bot.id)
        .eq("memory_class", "canonical")
        .eq("status", "pending_review")
        .limit(20);
      if (error) return giveUp(error.message);
      if (!pending || pending.length === 0) return { saved: 0 };
      const { data: settings, error: setErr } = await svc
        .from("tenant_meeting_settings")
        .select("enabled")
        .eq("tenant_id", bot.tenant_id)
        .maybeSingle();
      if (setErr) return giveUp(`settings read failed: ${setErr.message}`);
      if (!notetakerEnabledByDefault(settings)) return { saved: 0 };
      const r = await writeMeetingAtomsToBrain(
        svc,
        bot.tenant_id as string,
        {
          meeting_bot_id: bot.id,
          meeting_date: String(bot.scheduled_date),
          atoms: pending.map((a) => ({
            atom_type: a.atom_type,
            title: a.title,
            body: a.body ?? "",
            owner: a.owner ?? null,
            confidence: a.confidence,
            source_excerpt: a.source_excerpt ?? "",
          })),
        },
        { approvedBy: "auto" },
      );
      if (!r.ok) return giveUp(r.error);
      return { saved: r.written };
    });

    const notes = await step.run("save-notes", async () => {
      const giveUp = (what: string) => {
        if ((attempt ?? 0) < MEETING_PROCESS_RETRIES) throw new Error(`notes save: ${what}`);
        logger.error(`[meeting-process] notes not saved bot=${bot.id}: ${what}`);
        return { saved: false as const, reason: "save_failed" };
      };
      const { data: live, error: liveErr } = await svc.from("meeting_bots").select("status").eq("id", bot.id).maybeSingle();
      if (liveErr) return giveUp(`bot status read failed: ${liveErr.message}`);
      if (live?.status === "cancelled") return { saved: false, reason: "cancelled" };
      const { error } = await svc.from("meeting_notes").upsert(
        {
          bot_id: bot.id,
          tenant_id: bot.tenant_id,
          minutes: minutes ?? null,
          transcript: transcriptText,
        },
        { onConflict: "bot_id", ignoreDuplicates: true },
      );
      if (error) return giveUp(`upsert failed: ${error.message}`);
      if (minutes) {
        const { error: fillErr } = await svc
          .from("meeting_notes")
          .update({ minutes })
          .eq("bot_id", bot.id)
          .eq("tenant_id", bot.tenant_id as string)
          .is("minutes", null);
        if (fillErr) logger.error(`[meeting-process] notes summary fill failed bot=${bot.id}: ${fillErr.message}`);
      }
      const { data: row, error: readErr } = await svc
        .from("meeting_notes")
        .select("transcript, delete_after")
        .eq("bot_id", bot.id)
        .eq("tenant_id", bot.tenant_id as string)
        .maybeSingle();
      if (readErr) return giveUp(`read-back failed: ${readErr.message}`);
      const liveRow =
        typeof row?.transcript === "string" && row.transcript.trim().length > 0 && Date.parse(String(row.delete_after)) > Date.now();
      if (!liveRow) {
        logger.error(`[meeting-process] notes not saved bot=${bot.id}: no live transcript row after the save`);
        return { saved: false, reason: "save_failed" };
      }
      return { saved: true };
    });
    const transcriptSaved = notes?.saved === true;
    const notesSaveFailed = notes?.saved === false && (notes as { reason?: string }).reason === "save_failed";

    if (transcriptSaved) {
      await step.run("delete-media", async () => {
        const { data: row, error: readErr } = await svc.from("meeting_bots").select("media_deleted_at").eq("id", bot.id).maybeSingle();
        if (!readErr && row?.media_deleted_at) return { deleted: false, reason: "already_deleted" };
        try {
          await deleteBotMedia(bot.provider_bot_id as string);
          await svc
            .from("meeting_bots")
            .update({ media_deleted_at: new Date().toISOString() })
            .eq("id", bot.id)
            .is("media_deleted_at", null);
          return { deleted: true };
        } catch (e) {
          logger.error(`[meeting-process] delete_media failed bot=${bot.provider_bot_id}: ${(e as Error).message}`);
          return { deleted: false, reason: "delete_failed" };
        }
      });
    }

    let teamAlerted = false;
    if (distillFailed || notesSaveFailed) {
      const alert = await step.run("ops-alert", async () => {
        const out = await sendDistillFailureOpsAlert({
          tenant_id: bot.tenant_id as string,
          meeting_bot_id: bot.id as string,
          meeting_date: String(bot.scheduled_date),
          error: distillFailed ? (distillError ?? "distill failed") : "transcript could not be saved in Zavi",
          kind: distillFailed ? "distill_failed" : "transcript_not_saved",
          transcript_saved: transcriptSaved,
        });
        if (out?.sent !== true && out?.logged !== true) {
          if ((attempt ?? 0) < MEETING_PROCESS_RETRIES) throw new Error("ops page: neither the email nor the log row landed");
          logger.error(`[meeting-process] ops page lost bot=${bot.id} (email and praxis_logs both failed)`);
        }
        return { alerted: out?.sent === true };
      });
      teamAlerted = alert?.alerted === true;
    }

    const livePlan = async (): Promise<RecapPlan | null> => {
      const { data: settings, error } = await svc
        .from("tenant_meeting_settings")
        .select("recap_destination, slack_channel_id, slack_channel_name")
        .eq("tenant_id", bot.tenant_id as string)
        .maybeSingle();
      if (error) {
        logger.error(`[meeting-process] settings read failed bot=${bot.id}: ${error.message}`);
        return null;
      }
      return planRecapDelivery({
        destination: settings?.recap_destination ?? null,
        slackChannelId: (settings?.slack_channel_id as string | null | undefined) ?? null,
        slackChannelName: (settings?.slack_channel_name as string | null | undefined) ?? null,
        summonedFromThread: Boolean(bot.slack_channel_id && bot.slack_thread_ts),
      });
    };
    const plan: RecapPlan = await step.run(
      "recap-plan",
      async () => (await livePlan()) ?? { email: false, channel: null, thread: false, askOwner: false },
    );

    const list = atoms as MeetingAtom[];
    const render = () =>
      renderMeetingSummary({
        meeting_date: String(bot.scheduled_date),
        atoms: list,
        canonical_count: savedFacts?.saved ?? 0,
        minutes,
        approvals_url: workspaceUrl(),
        distill_failed: distillFailed,
        transcript_saved: transcriptSaved,
        team_alerted: teamAlerted,
      });

    if (plan.askOwner) {
      await step.run("ask-destination", async () => {
        const tenantId = bot.tenant_id as string;
        const { error: rowErr } = await svc
          .from("tenant_meeting_settings")
          .upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true });
        if (rowErr) logger.error(`[meeting-process] settings row ensure failed tenant=${tenantId}: ${rowErr.message}`);
        const { data: claimed, error } = await svc
          .from("tenant_meeting_settings")
          .update({ choose_destination_email_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .is("choose_destination_email_at", null)
          .is("recap_destination", null)
          .select("tenant_id, choose_destination_email_at");
        if (error) {
          logger.error(`[meeting-process] choose-destination latch failed tenant=${tenantId}: ${error.message}`);
          return { sent: 0, reason: "latch_failed" };
        }
        if (!claimed || claimed.length === 0) return { sent: 0, reason: "already_asked" };
        const stampedAt = (claimed[0] as { choose_destination_email_at?: string } | undefined)?.choose_destination_email_at;
        const release = async () => {
          if (!stampedAt) return;
          const { error: releaseErr } = await svc
            .from("tenant_meeting_settings")
            .update({ choose_destination_email_at: null })
            .eq("tenant_id", tenantId)
            .eq("choose_destination_email_at", stampedAt);
          if (releaseErr) {
            logger.error(`[meeting-process] choose-destination latch release failed tenant=${tenantId} (not asked again): ${releaseErr.message}`);
          }
        };
        try {
          const out = await sendChooseDestinationEmail(tenantId);
          if (out.sent === 0) await release();
          return out;
        } catch (e) {
          logger.error(`[meeting-process] choose-destination email failed tenant=${tenantId}: ${(e as Error).message}`);
          await release();
          return { sent: 0, reason: "send_failed" };
        }
      });
    }

    if (plan.email) {
      await step.run("summary-email", async () => {
        if (!(await livePlan())?.email) return { skipped: "destination_changed" };
        const { data: latch } = await svc
          .from("meeting_bots")
          .update({ summary_email_sent_at: new Date().toISOString() })
          .eq("id", bot.id)
          .is("summary_email_sent_at", null)
          .neq("status", "cancelled")
          .select("id")
          .maybeSingle();
        if (!latch) return { skipped: "already_sent" };
        try {
          return await sendMeetingSummaryEmail({
            tenant_id: bot.tenant_id as string,
            requested_by: (bot.requested_by as string | null) ?? null,
            meeting_date: String(bot.scheduled_date),
            atoms: list,
            canonical_count: savedFacts?.saved ?? 0,
            minutes,
            distill_failed: distillFailed,
            transcript_saved: transcriptSaved,
            team_alerted: teamAlerted,
          });
        } catch (e) {
          logger.error(`[meeting-process] summary email failed bot=${bot.id}: ${(e as Error).message}`);
          return { sent: 0, reason: "send_failed" };
        }
      });
    }

    if (plan.thread && bot.slack_channel_id && bot.slack_thread_ts) {
      await step.run("slack-summary", async () => {
        const { data: live, error: liveErr } = await svc.from("meeting_bots").select("status").eq("id", bot.id).maybeSingle();
        if (liveErr) throw new Error(`thread summary: bot status read failed: ${liveErr.message}`);
        if (live?.status === "cancelled") return { posted: false, reason: "cancelled" };
        if (!(await livePlan())?.thread) return { posted: false, reason: "destination_changed" };
        try {
          await slackFetch(
            bot.tenant_id as string,
            "chat.postMessage",
            {
              channel: bot.slack_channel_id as string,
              text: render().text.slice(0, 39000),
              thread_ts: bot.slack_thread_ts as string,
            },
            (bot.slack_team_id as string | undefined) ?? undefined,
          );
          return { posted: true };
        } catch (e) {
          logger.error(`[meeting-process] slack summary post failed bot=${bot.id}: ${(e as Error).message}`);
          return { posted: false };
        }
      });
    }

    if (plan.channel) {
      await step.run("slack-default-channel", async () => {
        const channel = (await livePlan())?.channel ?? null;
        if (!channel) return { posted: false, reason: "destination_changed" };
        const { data: claimed } = await svc
          .from("meeting_bots")
          .update({ default_slack_posted_at: new Date().toISOString() })
          .eq("id", bot.id)
          .is("default_slack_posted_at", null)
          .neq("status", "cancelled")
          .select("id");
        if (!claimed || claimed.length === 0) {
          return { posted: false, reason: "already_posted" };
        }

        try {
          await slackFetch(bot.tenant_id as string, "chat.postMessage", {
            channel: channel.id,
            text: render().text.slice(0, 39000),
          });
        } catch (e) {
          logger.error(`[meeting-process] default-channel post failed bot=${bot.id}: ${(e as Error).message}`);
          try {
            const told = await sendRecapPostFailedEmail(bot.tenant_id as string, channel.name);
            if (told.sent === 0) {
              logger.error(`[meeting-process] post-failed email not sent bot=${bot.id}: ${told.reason ?? "unknown"}`);
            }
          } catch (mailErr) {
            logger.error(`[meeting-process] post-failed email failed bot=${bot.id}: ${(mailErr as Error).message}`);
          }
          return { posted: false, reason: "post_failed" };
        }

        try {
          if (transcriptText.trim().length > 0) {
            await uploadFileToThread({
              tenant_id: bot.tenant_id as string,
              channel_id: channel.id,
              bytes: new TextEncoder().encode(transcriptText),
              filename: `transcript-${bot.scheduled_date}.txt`,
              title: `Meeting transcript — ${bot.scheduled_date}`,
            });
          }
        } catch (e) {
          logger.error(
            `[meeting-process] default-channel transcript upload failed bot=${bot.id}: ${(e as Error).message}`,
          );
        }
        return { posted: true };
      });
    }

    return { atoms: (atoms as MeetingAtom[]).length, distill_failed: distillFailed };
  },
);

export async function deleteExpiredMeetingNotes(now: Date = new Date()): Promise<{ deleted: number }> {
  const { data, error } = await serviceClient()
    .from("meeting_notes")
    .delete()
    .lt("delete_after", now.toISOString())
    .select("bot_id");
  if (error) throw new Error(`meeting notes retention failed: ${error.message}`);
  return { deleted: (data ?? []).length };
}

export async function blankOldMeetingExcerpts(): Promise<{ facts: number; cards: number }> {
  const { data, error } = await serviceClient().rpc("notetaker_blank_old_excerpts");
  if (error) throw new Error(`meeting excerpt retention failed: ${error.message}`);
  const out = (data ?? {}) as { facts?: unknown; cards?: unknown };
  return { facts: Number(out.facts ?? 0), cards: Number(out.cards ?? 0) };
}

export const meetingNotesRetentionFn = inngest.createFunction(
  { id: "meeting-notes-retention", concurrency: 1 },
  { cron: "15 * * * *" },
  async () => {
    const [notes, excerpts] = await Promise.allSettled([deleteExpiredMeetingNotes(), blankOldMeetingExcerpts()]);
    const failed = [notes, excerpts].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) throw new Error(failed.map((f) => (f.reason as Error)?.message ?? String(f.reason)).join("; "));
    return {
      ...(notes as PromiseFulfilledResult<{ deleted: number }>).value,
      excerpts_blanked: (excerpts as PromiseFulfilledResult<{ facts: number; cards: number }>).value,
    };
  },
);

export const meetingAtomsExpireFn = inngest.createFunction(
  { id: "meeting-atoms-expire", concurrency: 1 },
  { cron: "0 * * * *" },
  async () => {
    const { error } = await serviceClient()
      .from("meeting_atoms")
      .update({ status: "expired" })
      .eq("status", "auto_stored")
      .lt("expires_at", new Date().toISOString());
    if (error) throw new Error(`expire sweep failed: ${error.message}`);
    return { ok: true };
  },
);
