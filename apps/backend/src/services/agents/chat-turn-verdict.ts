
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";
import { parseDirectAdAsk } from "@/services/growth/direct-ad-ask";
import { messageRequestsOp } from "@/services/rules/load";
import { asksForWalletBalance } from "@/services/channels/chatgpt-ads/wallet-request-intent";
import { CHAT_CARD_OFFER_LINE } from "./channel-chat-mode";

export type ChatTurnVerdict = "answer" | "action";

const NO_CARDS =
  /\bno\s+cards?(?:\s+(?:needed|required|wanted|necessary|please|thanks)\b|\s*[,.;!]\s*(?:just|only|please|thanks)\b|\s*[.!]?\s*$)|\bwithout\s+(?:a\s+|any\s+)?cards?\b|\b(?:don'?t|do\s+not|never|no\s+need\s+to)\s+(?:\w+\s+){0,3}cards?\b/i;

const LEAD =
  /^(?:(?:ok(?:ay)?|great|cool|sure|yes|yeah|alright|so|and|also|then|now|hey|hi|zavi)\b[\s,!:-]*)*(?:please\s+|pls\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:can|could)\s+we\s+|(?:i\s+want|i\s+need|i'?d\s+like)\s+(?:you\s+)?to\s+|go\s+ahead\s+and\s+|let'?s\s+|just\s+)?/i;

const CARD_ASK = /^(?:make|create|file|add|open|turn|put|save)\b.{0,40}\bcards?\b/i;
const DRAFT_ASK =
  /^(?:draft|write|post|schedule|publish|send|prepare|compose|create|make|stage)\b.{0,40}\b(?:posts?|pins?|threads?|emails?|newsletters?|scripts?|tweets?|captions?|repl(?:y|ies)|reels?|videos?|carousels?|articles?|blogs?|ads?|copy|messages?|texts?|sms)\b/i;
const DO_IT_ASK = /^(?:launch|relaunch|duplicate|boost)\b|^(?:post|send|schedule|publish|shorten|extend|stage|pin)\s+(?:it|this|that|them|the)\b/i;
const EDIT_VERB = String.raw`(?:update|change|edit|rewrite|reword|rephrase|replace|swap|set|switch|retarget|prepare|create|make|build|set\s+up|authori[sz]e|pause|resume|unpause|turn\s+(?:on|off)|enable|disable|rename|archive|delete|remove)`;
const AD_EDIT_ASK = new RegExp(String.raw`^${EDIT_VERB}\b.{0,60}\b(?:campaigns?|ad\s*groups?|ad\s*sets?|ads?|targeting|audiences?|geo(?:locations?)?|communities|interests|destination|urls?|landing\s+page|links?|creatives?|images?|headlines?|authori[sz]ation|account|subject(?:\s+lines?)?|preview(?:\s+text)?|emails?|sequence|paragraphs?|wording|copy|body|cta|button)\b`, "i");
const EDIT_ECHO_QUESTION = new RegExp(String.raw`^${EDIT_VERB}\s+(?:(?:the|it|them|this|that)\s+)?(?:which|what|whose|whom|where|how|when|why)\b`, "i");
const EDIT_FAILURE = String.raw`(?:doesn'?t|does\s+not|didn'?t|did\s+not|won'?t|wouldn'?t|can'?t|cannot|isn'?t|is\s+not|wasn'?t|was\s+not|fails?|failed|broke|is\s+broken|errors?|errored|keeps|kept|stopped|shows?|showed|is\s+missing|is\s+(?:greyed|grayed)\s+out)`;
const EDIT_FINITE = String.raw`(?:doesn'?t|does\s+not|didn'?t|did\s+not|won'?t|wouldn'?t|can'?t|cannot|isn'?t|is\s+not|wasn'?t|was\s+not|fails|keeps|never|is\s+broken|is\s+missing|is\s+(?:greyed|grayed)\s+out)`;
const AD_OBJECT = String.raw`(?:campaigns?|ad\s*groups?|ad\s*sets?|ads?|posts?|creatives?|images?|headlines?|links?|audiences?|accounts?)\b`;
const NOT_DETERMINER = String.raw`(?<!\b(?:the|a|an|my|our|your|this|these|those|its|their|all|any|every|each|some|no)\s)`;
const EDIT_DESCRIBED = new RegExp(String.raw`^${EDIT_VERB}\s+(?:(?:(?!(?:that|which|who|whose|it|them|because|so|if|when|and|or|to|for)\b)[\w'-]+\s+){1,4}?${NOT_DETERMINER}|(?:button|option|feature|flow|tool|function|menu|tab)\b.{0,60}?\b)${EDIT_FAILURE}\b(?!\s+(?:[\w'-]+\s+)?${AD_OBJECT})|^${EDIT_VERB}\s+${EDIT_FINITE}\b`, "i");
const REQUEST_FRAME = /\b(?:please|pls|(?:can|could|would|will)\s+you|(?:can|could)\s+we|i\s+want|i\s+need|i'?d\s+like|go\s+ahead|let'?s)\b/i;

const DESCRIBED = /^(?!(?:make|create|write|publish|send|prepare|compose|add|turn|put|save|file|open|launch)\b)\w+\s+\w+\s+(?:is|are|was|were|isn'?t|aren'?t|wasn'?t|weren'?t|has|have|hasn'?t|haven'?t|keeps?|got)\b/i;

const ACCEPT =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|please do|do it|go ahead|go for it|sounds good|let'?s do it|make it|make the card|file it)(?:[\s,!.]+(?:yes|please|do it|go ahead|make it|file it))*[\s.!]*$/i;

const QUESTION =
  /\?\s*$|^(?:why|what|how|when|where|who|which|whose|is|are|was|were|does|did|do\s+(?:not|you|we|i|they|he|she)|can|could|should|would|will|explain|tell\s+me|show\s+me|walk\s+me|help\s+me\s+understand|any\s+idea)\b/i;

function clauseParts(text: string): Array<{ text: string; raw: string; asked: boolean; framed: boolean }> {
  return (text.match(/[^\n.!?;]+[\n.!?;]*/g) ?? []).flatMap((sentence) => {
    const asked = /\?/.test(sentence);
    const framed = REQUEST_FRAME.test(sentence);
    return sentence
      .split(/[\n.!?;,]+|\s+(?:but|then)\s+/i)
      .map((raw) => ({ raw: raw.trim(), text: raw.trim().replace(LEAD, "").trim() }))
      .filter((c) => c.text)
      .map((c) => ({ ...c, asked, framed }));
  });
}

export function offeredCard(prevAssistantText: string | null | undefined): boolean {
  return typeof prevAssistantText === "string" && prevAssistantText.toLowerCase().includes(CHAT_CARD_OFFER_LINE.toLowerCase());
}

export function classifyChatTurnByRules(
  userText: string | null | undefined,
  prevAssistantText: string | null | undefined,
): ChatTurnVerdict | "ambiguous" {
  const text = (userText ?? "").trim();
  if (!text) return "answer";
  if (NO_CARDS.test(text)) return "answer";
  if (parseDirectAdAsk(text) || asksForWalletBalance(text)) return "action";
  let bareEditQuestion = false;
  for (const { text: c, raw, asked, framed } of clauseParts(text)) {
    if (REQUEST_FRAME.test(raw) && !EDIT_ECHO_QUESTION.test(c) && AD_EDIT_ASK.test(c)) return "action";
    if (EDIT_ECHO_QUESTION.test(c) || EDIT_DESCRIBED.test(c)) continue;
    if (messageRequestsOp(c, "budget") || messageRequestsOp(c, "status")) return "action";
    if (DESCRIBED.test(c)) continue;
    if (CARD_ASK.test(c) || DRAFT_ASK.test(c) || DO_IT_ASK.test(c)) return "action";
    if (AD_EDIT_ASK.test(c)) {
      if (asked && !framed) bareEditQuestion = true;
      else return "action";
    }
  }
  if (bareEditQuestion) return "ambiguous";
  if (text.length <= 40 && ACCEPT.test(text)) return offeredCard(prevAssistantText) ? "action" : "answer";
  if (QUESTION.test(text)) return "answer";
  return "ambiguous";
}

const TIEBREAK_MODEL = "claude-haiku-4-5-20251001";
const TIEBREAK_TIMEOUT_MS = 1500;
const TIEBREAK_SYSTEM = [
  "A founder is chatting with the specialist that runs one of their marketing channels.",
  "Decide what the founder's latest message asks for.",
  "action = they ask the specialist to DO something on the channel: make or file a card, change a budget or status, launch, or draft content to publish.",
  "answer = they ask for information, an explanation, analysis or advice, or they are just talking.",
  "Reply with ONLY one lowercase word: answer OR action.",
].join("\n");

export async function chatTurnTiebreak(
  userText: string,
  prevAssistantText: string | null | undefined,
  tags: { tenantId?: string | null; agentSlug?: string | null; runId?: string | null },
): Promise<ChatTurnVerdict> {
  const prev = (prevAssistantText ?? "").slice(-600);
  const call = getAnthropic().messages.create(
    {
      model: TIEBREAK_MODEL,
      max_tokens: 4,
      temperature: 0,
      system: TIEBREAK_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Specialist's previous message (may be empty):\n${prev}\n\nFounder's latest message:\n${userText.slice(0, 1500)}`,
        },
      ],
    },
    { headers: heliconePropertyHeaders(tags) },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chatTurnTiebreak timeout after ${TIEBREAK_TIMEOUT_MS}ms`)), TIEBREAK_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([call, timeout]);
    const out = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").toLowerCase();
    if (/\baction\b/.test(out)) return "action";
    if (/\banswer\b/.test(out)) return "answer";
    throw new Error(`chatTurnTiebreak unparseable output: ${out.slice(0, 40)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveChatTurnVerdict(args: {
  userText: string | null | undefined;
  prevAssistantText: string | null | undefined;
  tags: { tenantId?: string | null; agentSlug?: string | null; runId?: string | null };
  tiebreak?: typeof chatTurnTiebreak;
}): Promise<ChatTurnVerdict> {
  const byRules = classifyChatTurnByRules(args.userText, args.prevAssistantText);
  if (byRules !== "ambiguous") return byRules;
  try {
    return await (args.tiebreak ?? chatTurnTiebreak)((args.userText ?? "").trim(), args.prevAssistantText, args.tags);
  } catch (e) {
    console.warn(`[chat-turn-verdict] tiebreak failed, treating the turn as a question: ${(e as Error).message}`);
    return "answer";
  }
}

type RunRow = { agent_slug?: unknown; trigger?: unknown; payload?: unknown };
type MsgRow = { body?: unknown; created_at?: unknown; thread_id?: unknown; sender_role?: unknown };

export type VerdictReader = {
  run(id: string): Promise<RunRow | null>;
  message(id: string): Promise<MsgRow | null>;
  assistantBefore(thread_id: string, before: string): Promise<string | null>;
};

export async function inheritedChatTurnVerdict(args: {
  originPayload: Record<string, unknown>;
  agent_slug: string;
  thread_id: string;
  reader: VerdictReader;
  tags: { tenantId?: string | null; agentSlug?: string | null; runId?: string | null };
  tiebreak?: typeof chatTurnTiebreak;
  maxHops?: number;
}): Promise<ChatTurnVerdict> {
  try {
    let payload = args.originPayload;
    for (let hop = 0; hop < (args.maxHops ?? 5); hop++) {
      if (payload.thread_id !== args.thread_id) return "answer";
      const next = typeof payload.prior_run_id === "string" && payload.prior_run_id
        ? payload.prior_run_id
        : typeof payload.user_message_id === "string" && payload.user_message_id
          ? null
          : payload.resume_of_run_id;
      if (next === null) {
        const msg = await args.reader.message(payload.user_message_id as string);
        if (!msg || msg.thread_id !== args.thread_id || msg.sender_role !== "user" || typeof msg.body !== "string") return "answer";
        const prev = typeof msg.created_at === "string" ? await args.reader.assistantBefore(args.thread_id, msg.created_at) : null;
        return resolveChatTurnVerdict({ userText: msg.body, prevAssistantText: prev, tags: args.tags, tiebreak: args.tiebreak });
      }
      if (typeof next !== "string" || !next) return "answer";
      const run = await args.reader.run(next);
      if (!run || run.agent_slug !== args.agent_slug || run.trigger !== "chat" || !run.payload || typeof run.payload !== "object") return "answer";
      payload = run.payload as Record<string, unknown>;
    }
  } catch (e) {
    console.warn(`[chat-turn-verdict] continuation verdict unreadable, treating as a question: ${(e as Error).message}`);
  }
  return "answer";
}
