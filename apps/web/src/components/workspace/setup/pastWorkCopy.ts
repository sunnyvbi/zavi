import { BUNDLE_PROMPT } from "./setupCopy";

export const PAST_WORK_TITLE = "Bring your past work";
export const PAST_WORK_SUBTITLE = "Move what your AI already knows to Zavi.";
export const PAST_WORK_COPY_HEADING = "Copy this prompt";
export const PAST_WORK_PASTE_HEADING = "Paste the answer here";
export const PAST_WORK_UPLOAD_HEADING = "Upload your files";
export const PAST_WORK_DEMO_FILENAME = "zavi-context.md";
export const PAST_WORK_DROP_LABEL = "Drop your files here, or choose files";
export const PAST_WORK_FILE_READY = "Ready to add";
export const PAST_WORK_FILE_ADDING = "Adding…";
export const PAST_WORK_FILE_SAVED = "Added. Zavi will read it in the background.";
export const PAST_WORK_PROMPT = BUNDLE_PROMPT;
export const AI_LINKS = [
  { name: "Claude", domain: "claude.ai", href: "https://claude.ai/new" },
  { name: "ChatGPT", domain: "chatgpt.com", href: "https://chatgpt.com/" },
  {
    name: "Gemini",
    domain: "gemini.google.com",
    href: "https://gemini.google.com/app",
  },
  { name: "Codex", domain: "openai.com", href: "https://chatgpt.com/codex" },
] as const;
export const PAST_WORK_ACCEPT = ".md,.txt,.pdf,.docx,.csv,.json";
export const PAST_WORK_LIMITS =
  ".md .txt .pdf .docx .csv .json · up to 20 files · 25 MB each";
export type PastWorkMode = "paste" | "files";
