export type ComposerSlashCommandName = "clear" | "help" | "run" | "decision" | "feedback";

export const COMPOSER_SLASH_COMMANDS: ReadonlyArray<{
  name: ComposerSlashCommandName;
  argHint: string;
  description: string;
}> = [
  {
    name: "clear",
    argHint: "",
    description: "Start a fresh thread. The current thread stays in Runs.",
  },
  {
    name: "help",
    argHint: "",
    description: "List every command this composer accepts.",
  },
  {
    name: "run",
    argHint: "[prompt]",
    description: "Force a structured run (no thread context).",
  },
  {
    name: "decision",
    argHint: "<uuid> <message>",
    description: "Attach a decisions row as context.",
  },
  {
    name: "feedback",
    argHint: "<rule>",
    description: "Save a rule for this agent. It follows it from its next run.",
  },
];

export function composerSlashCommandInstruction(): string {
  const list = COMPOSER_SLASH_COMMANDS.map((c) =>
    `\`/${c.name}${c.argHint ? ` ${c.argHint}` : ""}\` — ${c.description}`,
  ).join("\n  - ");
  return [
    "## Slash commands in the composer",
    `These are the ${COMPOSER_SLASH_COMMANDS.length} commands the message box offers, and the only ones you may recommend:`,
    `  - ${list}`,
    "NEVER invent a slash command. There is no `/schedule`, no `/remind`, no `/report` — a command that is not on that list returns `unknown_command`, and the operator hits a second wall right after the one they were already stuck on. If what they want has no command, say what they should type or click in plain words instead.",
  ].join("\n");
}
