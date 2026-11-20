import { COMPOSER_SLASH_COMMANDS, type ComposerSlashCommandName } from "@zavi/shared";
import { tenantCommandHint, tenantSlugList, type TenantCommandsState } from "./tenantCommands";

export type SlashKind = ComposerSlashCommandName;

export type SlashCommand = { kind: SlashKind; label: string; command: string; argHint: string; description: string };

const PHONE_WORDS: Record<SlashKind, { label: string; description: string }> = {
  clear: { label: "New chat", description: "Start fresh. This chat stays in your chat list." },
  help: { label: "What can I type?", description: "Lists these shortcuts." },
  run: { label: "Run a task on its own", description: "Zavi starts from your words only, without this chat's history." },
  decision: { label: "Ask about an approval", description: "Pick something waiting for you and ask about it." },
  feedback: { label: "Save a rule", description: "Save a rule for this agent. It follows it from its next run." },
};

export const SLASH_COMMANDS: SlashCommand[] = COMPOSER_SLASH_COMMANDS.map((c) => ({
  kind: c.name,
  label: PHONE_WORDS[c.name].label,
  command: `/${c.name}`,
  argHint: c.argHint,
  description: PHONE_WORDS[c.name].description,
}));

export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1].toLowerCase() : null;
}

export function filterSlash(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (c) => c.command.slice(1).startsWith(q) || c.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)),
  );
}

export type ParsedSend =
  | { kind: "chat"; body: string }
  | { kind: "force_run"; body: string }
  | { kind: "feedback"; body: string }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "attach_decision"; decisionId: string; body: string }
  | { kind: "unknown_command" };

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseSend(raw: string): ParsedSend {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.length === 1 || /^\/\s/.test(trimmed)) {
    return { kind: "chat", body: trimmed };
  }
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return { kind: "chat", body: trimmed };
  const body = (m[2] ?? "").trim();
  switch (m[1].toLowerCase()) {
    case "run":
      return { kind: "force_run", body };
    case "feedback":
      return body ? { kind: "feedback", body } : { kind: "unknown_command" };
    case "clear":
      return { kind: "clear" };
    case "help":
      return { kind: "help" };
    case "decision": {
      const dm = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
      if (!dm || !UUID_RE.test(dm[1])) return { kind: "unknown_command" };
      return { kind: "attach_decision", decisionId: dm[1], body: (dm[2] ?? "").trim() };
    }
    default:
      return { kind: "unknown_command" };
  }
}

export function turnText(p: ParsedSend): string | null {
  if (p.kind === "chat" || p.kind === "attach_decision") return p.body;
  if (p.kind === "force_run") return p.body || "(forced run)";
  return null;
}

export function slashHint(value: string, tenant?: TenantCommandsState): string | null {
  const p = parseSend(value);
  switch (p.kind) {
    case "unknown_command": {
      const name = /^\/(\S+)/.exec(value.trim())?.[1].toLowerCase();
      const known = SLASH_COMMANDS.find((c) => c.command === `/${name}`);
      if (known?.kind === "decision") return "Pick the approval from the / list (Ask about an approval) instead of typing its id.";
      if (known) return `Add ${known.argHint} after ${known.command}. ${known.description}`;
      const own = tenant ? tenantCommandHint(value, tenant) : undefined;
      if (own !== undefined) return own;
      const yours = tenant?.commands.length ? `, ${tenantSlugList(tenant.commands)}` : "";
      return `Unknown command. Available: /feedback, /clear, /help, /run, /decision <uuid>${yours}.`;
    }
    case "feedback":
      return "Send to save this as a rule for Zavi.";
    case "clear":
      return "Send to start a fresh chat.";
    case "help":
      return "Send to list every command.";
    case "force_run":
      return "Send to dispatch a structured run (no thread context).";
    case "attach_decision":
      return `Send to attach decision ${p.decisionId.slice(0, 8)}… as context.`;
    default:
      return null;
  }
}

export function feedbackConfirmation(body: string, status: string): string {
  if (status === "suggested") {
    return `Suggested as a rule for this agent: "${body}". An owner or admin can turn it on in Settings → Rules.`;
  }
  if (status === "duplicate" || status === "exists") return `That rule is already saved: "${body}".`;
  return `Rule saved for this agent: "${body}". It applies from its next run. See or change it in Settings → Rules.`;
}

export function mentionQuery(value: string): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value);
  return m ? m[1] : null;
}

export function stripMention(value: string): string {
  return value.replace(/(^|\s)@[^\s@]*$/, "$1");
}

export function filterMentions<T extends { name: string; executor: string }>(all: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...all];
  return all.filter((c) => c.executor.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}

export const MENTION_CONNECTABLE = new Set(["meta_ads", "google_ads", "google_analytics", "linkedin_social", "x_social"]);

export type ApprovalContext = { id: string; summary: string };

const APPROVAL_RE = /^About the approval "([\s\S]*?)" \(decision ([0-9a-f-]{36})\):\n([\s\S]*)$/i;

export function composeMessage(
  text: string,
  mention: { executor: string } | null,
  approval: ApprovalContext | null = null,
): string {
  let body = text.trim();
  if (approval) {
    const summary = approval.summary.replace(/"/g, "'").replace(/\s+/g, " ").slice(0, 120);
    body = `About the approval "${summary}" (decision ${approval.id}):\n${body || "Tell me about this approval."}`;
  }
  return mention ? `@${mention.executor} ${body}`.trim() : body;
}

export function emptyMentionHint(
  text: string,
  mention: { name: string } | null,
  approval: ApprovalContext | null = null,
): string | null {
  return mention && !approval && !text.trim() ? `Add your question for ${mention.name}.` : null;
}

export function splitApprovalContext(text: string): { approval: ApprovalContext | null; body: string } {
  const m = APPROVAL_RE.exec(text);
  return m ? { approval: { summary: m[1], id: m[2] }, body: m[3].trim() } : { approval: null, body: text };
}

export function approvalSummary(body: unknown): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["summary", "title", "description", "text", "message"]) {
      const v = b[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "An approval";
}

export function splitChannelMention<T extends { executor: string }>(
  text: string,
  channels: readonly T[],
): { channel: T | null; body: string } {
  const m = /^@([a-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text);
  const channel = m ? channels.find((c) => c.executor === m[1]) ?? null : null;
  if (!m || !channel) return { channel: null, body: text };
  return { channel, body: (m[2] ?? "").trim() };
}

type LibraryFile = { filename: string; mime: string; created_at: string };

const ATTACHABLE_EXTS = new Set(["pdf", "txt", "docx", "csv", "md", "markdown"]);
export const LIBRARY_LIMIT = 12;

export function fileExt(filename: string): string {
  const lower = filename.toLowerCase();
  return lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
}

export function isAttachableFile(a: LibraryFile): boolean {
  if (/^tab-task-.+\.jpg$/i.test(a.filename)) return false;
  if (a.mime.startsWith("image/")) return true;
  return ATTACHABLE_EXTS.has(fileExt(a.filename)) || a.mime === "text/markdown";
}

export function libraryAttachBlock(
  file: { mime: string },
  used: { image: number; doc: number },
  caps: { image: number; doc: number },
): string | null {
  if (used.image >= caps.image && used.doc >= caps.doc) return "This message is already full of attachments.";
  if (file.mime.startsWith("image/")) {
    return used.image >= caps.image ? `Max ${caps.image} images per message.` : null;
  }
  return used.doc >= caps.doc ? `Max ${caps.doc} files per message.` : null;
}

export function libraryFiles<T extends LibraryFile>(all: readonly T[]): T[] {
  return all.filter(isAttachableFile).slice(0, LIBRARY_LIMIT);
}

export function ago(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (min < 1) return "just now";
  if (min < 60) return unit(min, "minute");
  const h = Math.floor(min / 60);
  if (h < 24) return unit(h, "hour");
  const d = Math.floor(h / 24);
  if (d < 7) return unit(d, "day");
  if (d < 30) return unit(Math.floor(d / 7), "week");
  if (d < 365) return unit(Math.floor(d / 30), "month");
  return unit(Math.floor(d / 365), "year");
}
