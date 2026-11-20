import type { AdReviewCreative } from "@zavi/shared";
import { Steps } from "../card/blocks/Steps";
import { cardDisclosure } from "../card/styles";
import { CopyText } from "../card/blocks/CopyText";
import type { CardCopy } from "../card/cardModel";
import { copyTextOf } from "../card/cardPrimary";
import { exactChangeRows, type ActionItem } from "../types";
import { AdCreative, hasAdMedia } from "./blocks/AdCreative";
import { adReviewModel } from "../ads/adReviewModel";
import { ChangeRows } from "./blocks/ChangeRows";
import { shownDate } from "../ads/AdReviewSchedule";
import { InlineFacts, type Fact } from "./blocks/InlineFacts";
import { simpleCard, sponsoredPost, type SponsoredPost } from "./paidSpec";
import { POST_UNREADABLE, useLinkedInPostRead } from "../linkedin/linkedInPostRead";

const FACT_ROWS = /ad set|campaign|goes live|daily budget|comes from|audience/i;
const MONEY_ROWS = /budget|bid|spend|cap|cost/i;
const NO_PRIOR = /^(none|nothing yet)$/i;

function pendingChanges(a: ActionItem) {
  return exactChangeRows(a)
    .filter((r) => r.before && (!NO_PRIOR.test(r.before) || MONEY_ROWS.test(r.item)))
    .map((r) => (NO_PRIOR.test(r.before ?? "") ? { ...r, before: "" } : r));
}

function facts(a: ActionItem): Fact[] {
  const out: Fact[] = exactChangeRows(a).filter((r) => !r.before && FACT_ROWS.test(r.item)).slice(0, 3).map((r) => ({ label: r.item, value: r.after }));
  const schedule = a.body?.ad_review?.schedule;
  if (schedule?.start && !out.some((f) => /goes live/i.test(f.label))) out.push({ label: "Goes live", value: shownDate(schedule.start) });
  if (schedule?.end && !out.some((f) => /ends/i.test(f.label))) out.push({ label: "Ends", value: shownDate(schedule.end) });
  return out;
}

function PostText({ path, text }: { path: string; text: string | null }) {
  const { loading, read, refused } = useLinkedInPostRead(path);
  return <CopyText text={loading ? "Reading the post…" : read?.preview ?? text ?? refused ?? POST_UNREADABLE} />;
}

function SponsoredPostBody({ post }: { post: SponsoredPost }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {post.readPath ? <PostText path={post.readPath} text={post.text} /> : post.text && <CopyText text={post.text} />}
      <InlineFacts facts={post.facts} />
    </div>
  );
}

export function paidCreatives(a: ActionItem): AdReviewCreative[] {
  const modelled = adReviewModel(a).creatives;
  return modelled.some(hasAdMedia) ? modelled : a.body?.ad_review?.creatives ?? [];
}

export function PaidBody({ a, copy, edited, disclose = false }: { a: ActionItem; copy: CardCopy; edited: string | null; disclose?: boolean }) {
  const creatives = paidCreatives(a);
  const rows = exactChangeRows(a);
  if (creatives.length && !edited) {
    const post = sponsoredPost(a);
    const pending = disclose || post ? [] : pendingChanges(a);
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {post ? <SponsoredPostBody post={post} /> : creatives.map((c, i) => <AdCreative key={`${c.title ?? ""}-${i}`} creative={c} facts={i === 0 ? facts(a) : []} />)}
        {pending.length > 0 && <ChangeRows lead={null} rows={pending} />}
        {disclose && rows.length > 0 && (
          <details data-testid="done-exact-change" className="text-ca-action">
            <summary className={cardDisclosure}>Exact change</summary>
            <ChangeRows lead={null} rows={rows} />
          </details>
        )}
      </div>
    );
  }
  const changes = rows.filter((r) => r.before);
  const text = edited ?? copyTextOf(a);
  if (changes.length) return <><ChangeRows lead={copy.lead} rows={rows} />{text && <CopyText text={text} lists />}</>;
  if (text) return <>{!simpleCard(a) && <Steps lead={copy.lead} points={[]} />}<CopyText text={text} lists /></>;
  return <Steps lead={copy.lead} points={copy.points} />;
}
