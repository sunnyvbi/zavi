
import type Anthropic from "@anthropic-ai/sdk";
import { FILE_TEXT_PREFIX } from "./chat-history";

type MessageParam = Anthropic.Messages.MessageParam;

export const RECITATION_AGENT_SLUGS: ReadonlySet<string> = new Set([
  "operator",
  "engineer",
  "qa",
]);

export const RECITATION_EVERY_N_ITERS = 3;
export const RECITATION_OBJECTIVE_CAP = 240;

export function extractRecitationObjective(messages: MessageParam[]): string {
  if (!messages || messages.length === 0) return "";
  const first = messages[0];
  if (!first) return "";
  let text = "";
  if (typeof first.content === "string") {
    text = first.content;
  } else if (Array.isArray(first.content)) {
    text = first.content
      .map((b) =>
        b && typeof b === "object" && "type" in b && b.type === "text" &&
        typeof (b as { text?: unknown }).text === "string" &&
        !(b as { text: string }).text.startsWith(FILE_TEXT_PREFIX)
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > RECITATION_OBJECTIVE_CAP
    ? text.slice(0, RECITATION_OBJECTIVE_CAP) + "…"
    : text;
}

export function buildRecitationBlock(objective: string): string {
  const obj = (objective ?? "").trim();
  if (obj.length === 0) return "";
  return (
    `[dispatcher recitation] Stay anchored to the original objective — do not ` +
    `drift: "${obj}". If you've satisfied it, emit your envelope now instead of ` +
    `making more tool calls.`
  );
}
