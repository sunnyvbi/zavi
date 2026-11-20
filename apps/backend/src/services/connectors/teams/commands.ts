
export type TeamsCommand =
  | { kind: "greeting" }
  | { kind: "help" }
  | { kind: "ask_empty" }
  | { kind: "empty" }
  | { kind: "task"; text: string };

const GREETINGS = new Set([
  "hi", "hello", "hey", "hiya", "hi there", "hello there", "hey there", "yo",
  "good morning", "good afternoon", "good evening",
]);
const HELP = new Set(["help", "commands", "what can you do", "how does this work", "?"]);

export function classifyTeamsText(text: string): TeamsCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { kind: "empty" };
  const norm = trimmed.toLowerCase().replace(/[!.,?]+$/g, "").replace(/\s+/g, " ").trim();
  if (trimmed === "?" || HELP.has(norm) || HELP.has(norm.replace(/^\//, ""))) return { kind: "help" };
  if (GREETINGS.has(norm)) return { kind: "greeting" };
  const ask = /^\/?ask\b[:\s]*/i.exec(trimmed);
  if (ask) {
    const rest = trimmed.slice(ask[0].length).trim();
    return rest ? { kind: "task", text: rest } : { kind: "ask_empty" };
  }
  return { kind: "task", text: trimmed };
}

const SITE = "https://www.zaviagent.com";

const COMMANDS =
  `**What you can type**\n\n` +
  `- **help**: show this message.\n` +
  `- **ask** followed by your question, or just type the question.\n\n` +
  `For example: "Why did signups drop last week?" or "What should we test on the pricing page?"`;

const SUPPORT =
  `Help: ${SITE}/support · Contact: support@zaviagent.com`;

export const TEAMS_HELP_TEXT =
  `I'm Zavi, an AI growth agent for your business. ` +
  `Ask me a growth question and I'll reply in this conversation with an analysis and a proposed next step, ` +
  `or a draft such as ad copy or a short growth plan. In a channel, @mention me.\n\n` +
  `${COMMANDS}\n\n` +
  `To use Zavi you need a Zavi account; new to Zavi? Sign up free at ${SITE}/start. ` +
  `Replies are text only and usually take one to three minutes. ` +
  `Connecting data sources, approving changes and billing are in the Zavi web app at ${SITE}.\n\n` +
  SUPPORT;

export const TEAMS_GREETING_TEXT = `Hi! ${TEAMS_HELP_TEXT}`;

export const TEAMS_ASK_EMPTY_TEXT =
  `What would you like to ask? Type **ask** followed by your question, for example ` +
  `"ask what should we focus on this week to grow signups?". Type **help** to see everything I can do.`;

export const TEAMS_EMPTY_TEXT =
  `Sorry, I didn't understand that. I can only read text messages. ` +
  `Type **help** to see what I can do.`;

export const TEAMS_NOT_CONNECTED_TEXT =
  `Hi! I'm Zavi, an AI growth agent for your business. ` +
  `I answer growth questions right here in Teams.\n\n` +
  `**To get started, connect this Teams organization to a Zavi workspace:**\n\n` +
  `1. Sign up or sign in at ${SITE}/start (a free plan is available, no credit card needed).\n` +
  `2. Open the **Finish connecting Zavi** link I sent when the app was added, as a Zavi workspace owner or admin.\n` +
  `3. Link expired or missing? Remove the Zavi app and add it again, and I'll send a new one.\n\n` +
  `Once connected, type **help** to see what I can do, or just ask a question.\n\n` +
  SUPPORT;

export function teamsInstallWelcomeText(connectUrl: string, bindCode: string): string {
  return (
    `👋 Thanks for adding Zavi! Zavi is an AI growth agent for your business. ` +
    `Ask it a growth question in a chat or @mention it in a channel, and it replies right here ` +
    `with an analysis and a proposed next step, or a draft such as ad copy or a short growth plan.\n\n` +
    `**To use Zavi, you need a Zavi account, and this Teams organization must be connected to a Zavi workspace.** ` +
    `Replies are text only and usually take one to three minutes.\n\n` +
    `**Get started in 2 steps:**\n\n` +
    `1. No account yet? Sign up free at ${SITE}/start (no credit card needed).\n` +
    `2. As a Zavi workspace owner or admin, click **[Finish connecting Zavi →](${connectUrl})**. ` +
    `If the link doesn't open, sign in at ${SITE}/workspace?tab=settings and enter this code under ` +
    `**Microsoft Teams**: **${bindCode}** (expires in 15 minutes; remove and add the app again for a new one).\n\n` +
    `Once connected, type **help** to see what Zavi can do.\n\n` +
    SUPPORT
  );
}

export function connectedReplyFor(cmd: TeamsCommand): string | null {
  switch (cmd.kind) {
    case "greeting": return TEAMS_GREETING_TEXT;
    case "help": return TEAMS_HELP_TEXT;
    case "ask_empty": return TEAMS_ASK_EMPTY_TEXT;
    case "empty": return TEAMS_EMPTY_TEXT;
    case "task": return null;
  }
}
