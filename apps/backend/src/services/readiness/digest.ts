
import { sgSend } from "@/email/sendAuthEmail";

const DEFAULT_RECIPIENT = "ravi@zaviagent.com";
const TABLE_ROWS = 12;

export type DigestTenant = {
  tenant_id: string;
  name: string;
  prev_score: number | null;
  score: number;
  dims: Record<string, unknown>;
};

export type DigestDraft = {
  tenant_name: string;
  canonical_slug: string;
  confidence: string;
  snippet: string;
};

export type DigestInput = {
  tenants: DigestTenant[];
  drafts: DigestDraft[];
  dispatched: number;
  parked: number;
};

export function topBlocker(dims: Record<string, unknown>): string {
  const n = (k: string) => Number(dims[k] ?? 0);
  const gaps: Array<[string, number]> = [
    ["connectors", 30 - n("connectors")],
    ["verified brain", 20 - n("verified_brain")],
    ["measurable goal", 15 - n("goal_measurable")],
    ["a real deliverable", 15 - n("deliverable")],
    ["product URL", 10 - n("product_url")],
    ["founder engagement", 10 - n("founder_engaged")],
  ];
  gaps.sort((a, b) => b[1] - a[1]);
  return gaps[0][1] > 0 ? `${gaps[0][0]} (-${gaps[0][1]})` : "nothing";
}

export function renderReadinessDigest(input: DigestInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { tenants, drafts, dispatched, parked } = input;
  const under70 = tenants.filter((t) => t.score < 70);
  const movers = tenants.filter((t) => t.prev_score !== null && t.prev_score !== t.score);

  const lines: string[] = [];

  if (drafts.length > 0) {
    lines.push(`Discovery wrote ${drafts.length} draft${drafts.length === 1 ? "" : "s"} since yesterday. Review and promote:`);
    lines.push("");
    for (const d of drafts) {
      lines.push(`  [${d.confidence.toUpperCase()}] ${d.tenant_name} / ${d.canonical_slug}`);
      lines.push(`      ${d.snippet}`);
    }
    lines.push("");
  } else {
    lines.push("Discovery wrote no new drafts since yesterday.");
    lines.push("");
  }

  lines.push(`Fleet: ${tenants.length} tenants, ${under70.length} under 70 (not yet operable).`);
  lines.push("");

  const withDraft = new Set(drafts.map((d) => d.tenant_name));
  const ranked = [...tenants].sort((a, b) => b.score - a.score);
  const shown = ranked.filter(
    (t, i) => i < TABLE_ROWS || withDraft.has(t.name) || (t.prev_score !== null && t.prev_score !== t.score),
  );

  lines.push("  tenant                score   biggest gap");
  for (const t of shown) {
    const delta =
      t.prev_score === null || t.prev_score === t.score
        ? "    "
        : t.score > t.prev_score
          ? ` +${t.score - t.prev_score}`.padStart(4)
          : ` ${t.score - t.prev_score}`.padStart(4);
    lines.push(
      `  ${t.name.slice(0, 20).padEnd(20)} ${String(t.score).padStart(3)}${delta}   ${topBlocker(t.dims)}`,
    );
  }
  const hidden = tenants.length - shown.length;
  if (hidden > 0) {
    lines.push(`  ... and ${hidden} more scoring below the listed ones (mostly empty signup shells).`);
  }
  lines.push("");

  if (movers.length > 0) {
    lines.push(`Moved since yesterday: ${movers.map((m) => `${m.name} ${m.prev_score}->${m.score}`).join(", ")}`);
    lines.push("");
  }

  lines.push(
    `Discovery: ${dispatched} dispatched, ${parked} parked (parked = it already ran and nothing new has landed; the remaining gap is human-gated, not a retry).`,
  );

  const text = lines.join("\n");
  const subject =
    drafts.length > 0
      ? `Readiness: ${drafts.length} draft${drafts.length === 1 ? "" : "s"} to review, ${under70.length}/${tenants.length} under 70`
      : `Readiness: ${under70.length}/${tenants.length} under 70, no new drafts`;

  const html =
    '<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.55;white-space:pre-wrap">' +
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
    "</pre>";

  return { subject, text, html };
}

export async function sendReadinessDigest(
  input: DigestInput,
): Promise<{ sent: boolean; reason?: string }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    return { sent: false, reason: "no_system_key" };
  }
  const to = process.env.READINESS_DIGEST_TO ?? DEFAULT_RECIPIENT;
  const { subject, text, html } = renderReadinessDigest(input);
  try {
    await sgSend(to, subject, html, text);
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
