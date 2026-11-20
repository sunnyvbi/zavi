
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { joinMeetingNow } from "./join-now";
import { asRecapDestination } from "./recap-destination";
import { meetUrl } from "@/services/web-base";

export function summonAck(destination: unknown, tenantId: string): string {
  const d = asRecapDestination(destination);
  const onTheWay = "🎙️ On my way — admit *Zavi Notetaker* from the waiting room.";
  if (d === "slack" || d === "email") return `${onTheWay} I'll post the summary here after the call.`;
  if (d === "off") return `${onTheWay} Your team keeps meeting notes in Zavi only, so I won't post a summary here.`;
  return `${onTheWay} The notes will be saved in Zavi. An admin hasn't chosen where summaries go yet, so I won't post one here: ${meetUrl(tenantId)}`;
}

export { detectSummon } from "./summon-detect";

export async function handleSlackSummon(args: {
  tenant_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  meeting_url: string;
}): Promise<void> {
  const svc = serviceClient();
  let reply: string;
  try {
    const result = await joinMeetingNow({
      tenant_id: args.tenant_id,
      meeting_url: args.meeting_url,
      requested_by: null,
    });
    if (result.ok) {
      await svc
        .from("meeting_bots")
        .update({
          slack_team_id: args.team_id,
          slack_channel_id: args.channel_id,
          slack_thread_ts: args.thread_ts,
        })
        .eq("id", result.meeting_bot_id);
      const { data: settings } = await svc
        .from("tenant_meeting_settings")
        .select("recap_destination")
        .eq("tenant_id", args.tenant_id)
        .maybeSingle();
      reply = result.deduped ? "I'm already in that meeting 🎙️" : summonAck(settings?.recap_destination ?? null, args.tenant_id);
    } else {
      reply = `Couldn't join: ${result.message}`;
    }
  } catch (e) {
    reply = `Couldn't join: ${(e as Error).message.slice(0, 200)}`;
  }

  try {
    await slackFetch(
      args.tenant_id,
      "chat.postMessage",
      { channel: args.channel_id, text: reply, thread_ts: args.thread_ts },
      args.team_id,
    );
  } catch (e) {
    console.error(`[slack-summon] ack post failed tenant=${args.tenant_id}: ${(e as Error).message}`);
  }
}
