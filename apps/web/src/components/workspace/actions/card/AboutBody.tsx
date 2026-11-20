import { Markdown } from "@/components/workspace/Markdown";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";
import { cardEvidence, deliverableOf, deliverableParts, exactChangeRows, type ActionItem } from "../types";
import { ChangeRows } from "../paid/blocks/ChangeRows";
import { channelFamily } from "./family";
import { deliverableAbout, explainsFirst, fenceCode } from "./cardModel";
import { copyTextOf, isPostCard } from "./cardPrimary";
import { paidCreatives } from "../paid/PaidBody";

const VERBATIM = new Set(["reply", "send_message"]);

function FullText({ a, about, edited }: { a: ActionItem; about: string; edited: string | null }) {
  if (!edited && explainsFirst(a)) return null;
  const creatives = edited ? [] : paidCreatives(a).map((c) => c.body ?? c.descriptions?.[0] ?? "").filter(Boolean);
  const text = (edited ?? (creatives.length ? creatives.join("\n\n") : copyTextOf(a)))?.trim();
  if (!text || about.includes(text)) return null;
  const d = deliverableOf(a);
  const post = isPostCard(a) || VERBATIM.has(a.action_type) || creatives.length > 0;
  const label = d?.label ?? (post ? "Full text" : "Details");
  const parts = edited || a.action_type === "reply" ? null : deliverableParts(a);
  const source = parts ? deliverableAbout(a) : d?.kind === "code" ? `\`\`\`\n${text}\n\`\`\`` : fenceCode(text);
  return (
    <div data-testid="about-full-text">
      <p className="font-semibold text-ca-xdark">{label}</p>
      {post && !parts ? <p className="mt-1 whitespace-pre-line break-words text-ca-xdark [overflow-wrap:anywhere]">{text}</p> : <Markdown source={source} disableActionLinks />}
    </div>
  );
}

function provenanceOf(a: ActionItem): string | null {
  if (a.body?.ad_review?.provenance) return a.body.ad_review.provenance;
  if (a.source !== "channel_action") return null;
  if (a.channel_slug !== REDDIT_ORGANIC_SLUG) return "Saved channel proposal";
  if (a.run_id) return "From a Zavi run";
  return a.body?.step?.deliverable?.presentation?.type === "reddit_reply" ? "Drafted by Zavi from your Reddit scan" : "Saved channel proposal";
}

export function AboutBody({ a, about, steps, edited = null }: { a: ActionItem; about: string; steps?: string[]; edited?: string | null }) {
  const evidence = cardEvidence(a);
  const tiles = [...evidence.stats, ...evidence.estimate];
  const provenance = provenanceOf(a);
  const rows = channelFamily(a.channel_slug) === "paid" ? exactChangeRows(a) : [];
  return (
    <div className="flex flex-col gap-3 [&_pre]:!text-[13px] [&_pre]:!leading-5 [&_pre_code]:!text-[13px] sm:[&_pre]:!text-[14px] sm:[&_pre_code]:!text-[14px]">
      <Markdown source={about} disableActionLinks />
      <FullText a={a} about={about} edited={edited} />
      {!!steps?.length && <ol data-testid="about-steps" className="list-decimal pl-5">{steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      {evidence.reason && <p>{evidence.reason}</p>}
      {tiles.length > 0 && (
        <ul data-testid="about-evidence" className="flex flex-col gap-1">
          {tiles.map((t) => <li key={`${t.value}-${t.caption}`}><span className="font-semibold text-ca-xdark">{t.value}</span> {t.caption}</li>)}
        </ul>
      )}
      {rows.length > 0 && <div data-testid="about-exact-change"><p className="font-semibold text-ca-xdark">Exact change</p><ChangeRows lead={null} rows={rows} /></div>}
      {provenance && <p data-testid="action-provenance">Comes from: {provenance}</p>}
    </div>
  );
}
