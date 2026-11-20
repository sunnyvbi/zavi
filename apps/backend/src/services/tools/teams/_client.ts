
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getTeamsAdapter, teamsEnv } from "@/services/connectors/teams/adapter";

export type TeamsReplyResult =
  | { ok: true }
  | { ok: false; disabled?: boolean; gone?: boolean; error: string };

const MAX_TEAMS_TEXT = 28_000;

export const AI_GENERATED_ENTITY = {
  type: "https://schema.org/Message",
  "@type": "Message",
  "@context": "https://schema.org",
  "@id": "",
  additionalType: ["AIGeneratedContent"],
} as const;

export async function postTeamsReply(args: {
  conversationReference: unknown;
  text: string;
  aiGenerated?: boolean;
}): Promise<TeamsReplyResult> {
  const env = teamsEnv();
  const adapter = await getTeamsAdapter();
  if (!env || !adapter) {
    return { ok: false, disabled: true, error: "teams_disabled" };
  }
  if (!args.conversationReference || typeof args.conversationReference !== "object") {
    return { ok: false, error: "no_conversation_reference" };
  }

  let text = (args.text ?? "").trim();
  if (!text) return { ok: false, error: "empty_text" };
  if (text.length > MAX_TEAMS_TEXT) text = text.slice(0, MAX_TEAMS_TEXT);

  try {
    await adapter.continueConversationAsync(
      env.appId,
      args.conversationReference,
      async (context: any) => {
        await context.sendActivity({
          type: "message",
          text,
          ...(args.aiGenerated ? { entities: [AI_GENERATED_ENTITY] } : {}),
        });
      },
    );
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const gone = /\b(403|404|Forbidden|not\s*found)\b/i.test(msg);
    return { ok: false, gone, error: msg };
  }
}
