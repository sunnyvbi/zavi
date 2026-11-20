
import { channelForAgent, type ChannelAgent } from "./channel-agents";

export const CHAT_CARD_OFFER_LINE = "Want me to make this a card?";

export function channelChatAgent(agentSlug: string, trigger: string): ChannelAgent | null {
  return trigger === "chat" ? channelForAgent(agentSlug) : null;
}

export function channelChatPrompt(channel: ChannelAgent): string {
  return [
    "## This is a chat, not a run",
    `You are the founder's ${channel.name} specialist, talking with them in a chat about this channel. Answer the question they actually asked, in plain prose, using only the tools that question needs. The channel playbook is your know-how, not a checklist to run.`,
    "The scheduled-run output contract (the report, a <digest>, 1-5 steps, a propose call) does not apply in a chat.",
    `When your answer leads to something worth doing on this channel, say what you would do and end with one line: "${CHAT_CARD_OFFER_LINE}"`,
    "Make a card only after the founder says yes or plainly asks you to do or draft something. Then file exactly what they agreed to: use your propose tool for that action when you have one, otherwise reply with your normal run envelope holding only those steps. Never file a card they did not ask for, and never say a card changed until a tool result says the new draft was saved.",
  ].join("\n");
}
