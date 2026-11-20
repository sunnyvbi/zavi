
import { randomUUID } from "node:crypto";
import {
  CONNECTOR_REQUEST_KIND,
  CONNECTOR_CONNECT,
  connectInfoFor,
  connectorSettingsPath,
  type ConnectorRequest,
} from "@zavi/shared";
import { scrubAgentEgress } from "./scrub-agent-egress";
import { connectorErrorMode, type ToolCallTrace } from "@/services/tools/types";

export const CONNECTOR_REQUEST_TOOL = "connectors__request";

export const CONNECTOR_REQUEST_DENY_MESSAGE =
  "Card shown to the user. Reply in one short line saying what you need and why, then stop.";

export const WEB_APP_ORIGIN = "https://www.zaviagent.com";

const INTERACTIVE_TRIGGERS: ReadonlySet<string> = new Set([
  "chat",
  "slack",
  "whatsapp",
  "imessage",
  "telegram",
  "teams",
  "discord",
]);

export function isInteractiveTrigger(trigger: string): boolean {
  return INTERACTIVE_TRIGGERS.has(trigger);
}

export function isConnectorRequestToolName(name: string): boolean {
  return name === CONNECTOR_REQUEST_TOOL || name.endsWith(`__${CONNECTOR_REQUEST_TOOL}`);
}

export type EmitConnectorRequestInput = {
  slug: string;
  label?: string;
  reason: string;
  origin: ConnectorRequest["origin"];
  mode: ConnectorRequest["mode"];
  run_id: string;
  trigger: string;
  now?: Date;
};

export type EmitConnectorRequestResult = {
  request: ConnectorRequest | null;
  text: string;
};

function scrubReason(reason: string): string {
  const scrubbed = scrubAgentEgress(reason, { surface: "chat", scrubPii: true }).text;
  return scrubbed.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function emitConnectorRequest(
  input: EmitConnectorRequestInput,
): EmitConnectorRequestResult | null {
  const info = connectInfoFor(input.slug, input.label?.slice(0, 80));
  if (!info) return null;
  const label = info.label.slice(0, 80);
  const verb = input.mode === "reconnect" ? "reconnect" : "connect";
  if (input.trigger !== "chat") {
    return {
      request: null,
      text: `I need ${label} for this. ${verb === "reconnect" ? "Reconnect" : "Connect"} it: ${WEB_APP_ORIGIN}${connectorSettingsPath(info)}`,
    };
  }
  return {
    request: {
      kind: CONNECTOR_REQUEST_KIND,
      v: 1,
      request_id: randomUUID(),
      slug: input.slug,
      label,
      connect: info.connect,
      reason: scrubReason(input.reason),
      origin: input.origin,
      mode: input.mode,
      run_id: input.run_id,
      created_at: (input.now ?? new Date()).toISOString(),
    },
    text:
      input.mode === "reconnect"
        ? `I need you to reconnect ${label} for this.`
        : `I need ${label} for this.`,
  };
}

export function replyTextWithConnectorRequest(
  outputText: string,
  emitted: EmitConnectorRequestResult,
  origin: ConnectorRequest["origin"],
): string {
  const own = outputText.trim();
  if (emitted.request) return own.length > 0 ? outputText : emitted.text;
  if (origin === "tool_error" && own.length > 0) return `${outputText}\n\n${emitted.text}`;
  return emitted.text;
}

export function selectBackstopConnector(
  toolCalls: readonly ToolCallTrace[],
): { slug: string; mode: ConnectorRequest["mode"] } | null {
  for (const t of toolCalls) {
    if (t.status !== "tool_error" || !t.connector_slug) continue;
    const mode = connectorErrorMode(t.code) ? (t.connector_mode ?? connectorErrorMode(t.code)) : null;
    if (mode) return { slug: t.connector_slug, mode };
  }
  return null;
}

const ACTION_LINK_RE = /\/__praxis_action__\/(connect|reauth):([a-z0-9_.-]+)/g;

export function findConnectActionLink(
  text: string,
): { slug: string; verb: "connect" | "reauth" } | null {
  for (const m of text.matchAll(ACTION_LINK_RE)) {
    const slug = m[2].replace(/[.-]+$/, "");
    if (connectInfoFor(slug)) return { slug, verb: m[1] as "connect" | "reauth" };
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripConnectActionLinks(text: string, slug: string): string {
  const path = `/__praxis_action__/(?:connect|reauth):${escapeRe(slug)}(?![a-z0-9_])`;
  const md = new RegExp(`\\[[^\\]\\n]*\\]\\(${path}\\)`, "g");
  const bare = new RegExp(path, "g");
  const has = new RegExp(path);
  const lines = text.split("\n").map((line) => {
    if (!has.test(line)) return line;
    const without = line.replace(md, "").replace(bare, "");
    if (!/[\p{L}\p{N}]/u.test(without)) return null;
    return line
      .replace(md, (m) => m.slice(1, m.indexOf("](")))
      .replace(bare, "")
      .replace(/[ \t]+$/, "");
  });
  return lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ActionLinkValidation =
  | { ok: true; slug: string; label: string }
  | { ok: false; error: string };

export async function promoteConnectActionLink(input: {
  text: string;
  run_id: string;
  trigger: string;
  toolCalls: readonly ToolCallTrace[];
  validate: (slug: string) => Promise<ActionLinkValidation>;
}): Promise<{ emitted: EmitConnectorRequestResult; text: string } | null> {
  if (input.trigger !== "chat") return null;
  const link = findConnectActionLink(input.text);
  if (!link) return null;
  const v = await input.validate(link.slug);
  let mode: ConnectorRequest["mode"];
  if (v.ok) mode = "connect";
  else if (
    link.verb === "reauth" &&
    v.error === "already_connected" &&
    input.toolCalls.some(
      (t) =>
        t.status === "tool_error" &&
        t.connector_slug === link.slug &&
        (t.connector_mode ?? connectorErrorMode(t.code)) === "reconnect",
    )
  )
    mode = "reconnect";
  else return null;
  const emitted = emitConnectorRequest({
    slug: link.slug,
    label: v.ok ? v.label : undefined,
    reason: "",
    origin: "model",
    mode,
    run_id: input.run_id,
    trigger: input.trigger,
  });
  if (!emitted?.request) return null;
  return { emitted, text: stripConnectActionLinks(input.text, link.slug) };
}

const MISSING_REPLY_NAMES = (() => {
  const names = new Map<string, string>();
  for (const [slug, info] of Object.entries(CONNECTOR_CONNECT)) {
    if (info.label === "X" || info.label === "your database") continue;
    if (!names.has(info.label.toLowerCase())) names.set(info.label.toLowerCase(), slug);
  }
  names.set("ga4", "google_analytics");
  names.set("search console", "google_search_console");
  names.set("meta", "meta_ads");
  return [...names].sort(([a], [b]) => b.length - a.length).map(([name, slug]) => {
    const service = `(?:your |our |the )?${escapeRe(name)}(?=$|[\\s.,;:!?()-])`;
    const adverb = `(?:(?:also|still|currently)\\s+)?`;
    return {
      slug,
      name,
      absent: new RegExp(`^${service}\\s+${adverb}(?:(?:is|are)\\s+(?:not|never)|isn't|aren't|has not been|hasn't been)\\s+(?:yet\\s+)?(?:connected|linked|configured|set up|integrated)\\b`, "i"),
      access: new RegExp(`^(?:i|we)\\s+${adverb}(?:(?:cannot|can't|can not)\\s+(?:access|read)\\s+|(?:don't|do not)\\s+have access to\\s+)${service}`, "i"),
      elliptical: new RegExp(`^${service}\\s+${adverb}(?:isn't|aren't|is not|are not)[.!]?$`, "i"),
      notNeeded: new RegExp(`\\b${service}\\s+${adverb}(?:isn't|is not|is never)\\s+(?:needed|required|necessary)\\b|\\b(?:i|we|you)\\s+${adverb}(?:don't|do not)\\s+need\\s+${service}`, "i"),
    };
  });
})();

const OTHER_ACCESS_FAILURE = /\b(?:permission|permissions|scope|scopes|forbidden|denied|rate[ -]?limit(?:ed|ing)?|temporar(?:y|ily)|timeout|timed out|try again|retry)\b|\bHTTP\s*(?:401|403|429|5\d\d)\b/i;
const HYPOTHETICAL_CONNECTION = /\b(?:if|when|unless|suppose|imagine|example|hypothetical)\b/i;
const META_ORGANIC_CONTEXT = /\b(?:instagram|facebook page|organic|publish(?:ing)?|post(?:s|ing)?|reels?|stor(?:y|ies))\b/i;
const CONNECTION_NOT_NEEDED = /\b(?:it|this connection|that connection)\s+(?:(?:also|still|currently)\s+)?(?:isn't|is not|is never)\s+(?:needed|required|necessary)\b|\b(?:i|we|you)\s+(?:(?:also|still|currently)\s+)?(?:don't|do not)\s+need\s+(?:it|this connection|that connection)\b/i;

function missingConnectorInReply(text: string): string | null {
  const prose = text.slice(0, 8000)
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[*_]/g, "");
  const sentences = prose.split(/(?<=[.!?])\s+|\n+/);
  for (const [i, sentence] of sentences.entries()) {
    if (/^\s*>/.test(sentence) || /\?\s*$/.test(sentence) || HYPOTHETICAL_CONNECTION.test(sentence)) continue;
    if (OTHER_ACCESS_FAILURE.test(`${sentence} ${sentences[i + 1] ?? ""}`)) continue;
    const connectionContext = /\b(?:connected|linked|configured|integrated)\b/i.test(sentence);
    for (const part of sentence.split(/\s+(?:but|however|whereas|because|since)\s+|:\s+/i)) {
      const clause = part.trim().replace(/^(?:[-]\s+|\d+[.)]\s+)/, "").replace(/^(?:unfortunately|currently),?\s+/i, "");
      const match = MISSING_REPLY_NAMES.find(n => n.absent.test(clause) || n.access.test(clause) || (connectionContext && n.elliptical.test(clause)));
      if (match) {
        const context = `${sentence} ${sentences[i + 1] ?? ""}`;
        if (match.notNeeded.test(context) || CONNECTION_NOT_NEEDED.test(context)) continue;
        if (match.name === "meta" && META_ORGANIC_CONTEXT.test(context)) continue;
        return match.slug;
      }
    }
  }
  return null;
}

export async function promoteMissingConnectorReply(input: {
  text: string;
  run_id: string;
  trigger: string;
  validate: (slug: string) => Promise<ActionLinkValidation>;
}): Promise<{ emitted: EmitConnectorRequestResult; text: string } | null> {
  if (input.trigger !== "chat") return null;
  const slug = missingConnectorInReply(input.text);
  if (!slug) return null;
  try {
    const validated = await input.validate(slug);
    if (!validated.ok) return null;
    const emitted = emitConnectorRequest({
      slug: validated.slug, label: validated.label, reason: "", origin: "model",
      mode: "connect", run_id: input.run_id, trigger: input.trigger,
    });
    return emitted?.request ? { emitted, text: input.text } : null;
  } catch {
    return null;
  }
}
