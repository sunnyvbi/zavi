
import { CHANNELS, GROWTH_CHANNEL_SLUGS, GROWTH_DECISION_CLASSES, channelForBriefKind } from "@zavi/shared";
import { SITE_PR_CLASSES, channelOfSitePrClass } from "@/services/channels/site-pr-run";
import { HUMAN_APPLICATION_REVIEW_CLASS } from "@/services/humans/applications";
import { SOCIAL_ACTION_CHANNEL_SLUG, SOCIAL_PUBLISH_CLASS } from "@/routes/approvals/decision-channel";

function briefKindChannels(): Array<[string, string]> {
  const kinds: string[] = [];
  for (const c of CHANNELS as ReadonlyArray<{ human?: { available?: boolean; brief_kind?: string } }>) {
    const k = c.human?.available === true ? c.human.brief_kind : undefined;
    if (typeof k === "string" && !kinds.includes(k)) kinds.push(k);
  }
  return kinds
    .map((k) => [k, channelForBriefKind(k)?.slug] as const)
    .filter((e): e is readonly [string, string] => typeof e[1] === "string")
    .map(([k, s]) => [k, s]);
}

export const DECISION_HOME_SQL_INPUTS = {
  channelSlugs: [...GROWTH_CHANNEL_SLUGS],
  growthExact: [...GROWTH_DECISION_CLASSES.exact] as string[],
  growthPrefixes: [...GROWTH_DECISION_CLASSES.prefixes] as string[],
  sitePrClasses: [...SITE_PR_CLASSES].sort(),
  humanReviewClass: HUMAN_APPLICATION_REVIEW_CLASS,
  socialPublishClass: SOCIAL_PUBLISH_CLASS,
  socialActionChannel: Object.entries(SOCIAL_ACTION_CHANNEL_SLUG).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  briefKindChannel: briefKindChannels(),
} as const;

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const arr = (xs: readonly string[]): string => `array[${xs.map(lit).join(", ")}]::text[]`;

export function renderDecisionHomeSql(): string {
  const i = DECISION_HOME_SQL_INPUTS;
  const sitePrCases = i.sitePrClasses
    .map((cls) => `        when ${lit(cls)} then ${lit(channelOfSitePrClass(cls) as string)}`)
    .join("\n");
  const briefCases = i.briefKindChannel.map(([k, s]) => `        when ${lit(k)} then ${lit(s)}`).join("\n");
  const socialCases = i.socialActionChannel.map(([k, s]) => `        when ${lit(k)} then ${lit(s)}`).join("\n");
  const growth = [
    `p_class = any (${arr(i.growthExact)})`,
    ...i.growthPrefixes.map((p) => `starts_with(p_class, ${lit(p)})`),
  ].join("\n        or ");
  return `create or replace function public.decision_home_of(
  p_class text,
  p_run_channel text,
  p_run_enqueued_by uuid,
  p_site_pr_class text,
  p_brief_kind text,
  p_social_channel text
) returns table (home text, home_channel text)
language sql immutable
set search_path = public, pg_temp
as $fn$
  with resolved as (
    select case
      when nullif(p_run_channel, '') is not null then p_run_channel
      when p_run_enqueued_by is null and p_site_pr_class = any (${arr(i.sitePrClasses)}) then case p_site_pr_class
${sitePrCases}
      end
      when p_class = ${lit(i.humanReviewClass)} then case p_brief_kind
${briefCases}
      end
      when p_class = ${lit(i.socialPublishClass)} then case p_social_channel
${socialCases}
      end
    end as ch
  ),
  known as (
    select case when ch = any (${arr(i.channelSlugs)}) then ch end as ch from resolved
  )
  select
    case
      when known.ch is not null then 'channel'
      when coalesce(${growth}, false) then 'growth'
      else 'needs_you'
    end,
    known.ch
  from known
$fn$;`;
}
