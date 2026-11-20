
import {
  COMPOSER_SLASH_COMMANDS,
  type ComposerSlashCommandName,
} from "@zavi/shared";

export type SlashCommand = {
  name: string;
  argHint: string;
  description: string;
  kind: "feedback" | "force_run" | "attach_decision" | "clear" | "help";
};

const KIND_BY_NAME: Record<ComposerSlashCommandName, SlashCommand["kind"]> = {
  clear: "clear",
  help: "help",
  run: "force_run",
  decision: "attach_decision",
  feedback: "feedback",
};

export const SLASH_COMMANDS: SlashCommand[] = COMPOSER_SLASH_COMMANDS.map((c) => ({
  name: c.name,
  argHint: c.argHint,
  description: c.description,
  kind: KIND_BY_NAME[c.name],
}));

export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
