
import type { ToolCallTrace } from "@/services/tools/types";
import { canonicalRedditUrl } from "@/services/channels/reddit/permalink";

const TRUNCATION_MARKERS = ['"_truncated"', "[elided]", "_elided_fields"];

export type CommunityRules = {
  text: string;
  complete: boolean;
};

export type RunEvidence = {
  threadsRead: Set<string>;
  rulesByCommunity: Map<string, CommunityRules>;
};

export function normaliseThreadUrl(raw: string): string {
  const trimmed = raw.trim().replace(/[)\]>,.]+$/, "");
  const canonical = canonicalRedditUrl(trimmed);
  if (canonical) return canonical.replace(/^https:\/\/www\./, "").replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.toLowerCase().replace(/\/+$/, "")}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

function looksTruncated(s: string): boolean {
  return TRUNCATION_MARKERS.some((m) => s.includes(m));
}

function threadUrlsIn(s: string): string[] {
  return (s.match(/https?:\/\/[^\s"'<>)\]]*reddit\.com\/r\/[^\s"'<>)\]]+/gi) ?? []).filter((u) =>
    /\/comments\//i.test(u),
  );
}

function threadReadFrom(call: ToolCallTrace): string | null {
  if (call.status !== "ok") return null;
  const out = String(call.output_preview ?? "");
  if (!/"found"\s*:\s*true/.test(out)) return null;
  const fromInput = threadUrlsIn(String(call.input_preview ?? ""))[0];
  const fromOutput = threadUrlsIn(out)[0];
  const url = fromInput ?? fromOutput;
  return url ? normaliseThreadUrl(url) : null;
}

function communitiesIn(out: string): Array<{ name: string; description: string }> {
  const found: Array<{ name: string; description: string }> = [];
  try {
    const parsed = JSON.parse(out) as unknown;
    const rows: Array<{ name?: unknown; description?: unknown; subreddit?: unknown; rules_text?: unknown }> = [];
    const asObj = parsed as Record<string, unknown>;
    if (Array.isArray((asObj as { communities?: unknown }).communities)) {
      rows.push(...((asObj as { communities: Array<Record<string, unknown>> }).communities));
    }
    if (typeof asObj?.subreddit === "string") rows.push(asObj);
    for (const r of rows) {
      const name = typeof r.name === "string" ? r.name : typeof r.subreddit === "string" ? r.subreddit : null;
      const desc =
        typeof r.description === "string" ? r.description : typeof r.rules_text === "string" ? r.rules_text : "";
      if (name) found.push({ name, description: desc });
    }
    if (found.length > 0) return found;
  } catch {
  }
  const single = /"subreddit"\s*:\s*"([^"]{1,80})"[\s\S]{0,400}?"rules_text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(out);
  if (single) found.push({ name: single[1], description: single[2] });
  const re = /"name"\s*:\s*"([^"]{1,80})"[\s\S]{0,200}?"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(out); m; m = re.exec(out)) found.push({ name: m[1], description: m[2] });
  return found;
}

export function readRunEvidence(tool_calls: ToolCallTrace[] | undefined): RunEvidence {
  const threadsRead = new Set<string>();
  const rulesByCommunity = new Map<string, CommunityRules>();
  for (const call of tool_calls ?? []) {
    const name = String(call.name ?? "");
    if (/thread_read/.test(name)) {
      const url = threadReadFrom(call);
      if (url) threadsRead.add(url);
      continue;
    }
    if (!/scrape_reddit|community_rules/.test(name) || call.status !== "ok") continue;
    const out = String(call.output_preview ?? "");
    const cut = looksTruncated(out);
    for (const c of communitiesIn(out)) {
      const key = c.name.trim().replace(/^\/?r\//i, "").toLowerCase();
      const text = c.description.replace(/\\n/g, "\n").replace(/\\"/g, '"');
      const prior = rulesByCommunity.get(key);
      if (prior?.complete && cut) continue;
      rulesByCommunity.set(key, { text, complete: !cut && text.length > 0 });
    }
  }
  return { threadsRead, rulesByCommunity };
}
