
import type { DeepAgentPromptProfile } from "./types";
import { CODEX_PROFILE } from "./codex";

const CLAUDE_MODEL_ADDENDUM = [
  "CLAUDE PROFILE:",
  "- You may be concise, but never skip required envelope/digest shapes — structure beats brevity.",
  "- When reconciling numbers, show working in /scratch/ even if you could answer in prose.",
  "- Prefer read_file on /skills/ before improvising a procedure.",
  "- Subagent replies must stay pointer-shaped (≤5 lines + file path) — do not paste full tables inline.",
].join("\n");

export const CLAUDE_PROFILE: DeepAgentPromptProfile = {
  ...CODEX_PROFILE,
  id: "claude",
  label: "Anthropic Claude",
  modelAddendum: CLAUDE_MODEL_ADDENDUM,
};
