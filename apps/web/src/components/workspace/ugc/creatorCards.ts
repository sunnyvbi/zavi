
import {
  BUSINESS_FEE_BPS,
  CHANNELS,
  CREATOR_VIDEO_CHANNEL_SPECS,
  CREATOR_VIDEO_PREFILL,
  isCreatorVideoChannel,
  type CreatorVideoChannel,
} from "@zavi/shared";
import type { HumanBrief } from "@/components/humans/humanTypes";
import type { CreatorJobSummary } from "@/components/humans/creatorJobTypes";
import { dayTimeUtc, firstName, money, shortDay, type DrawerName, type DrawerParams } from "./hub";

export type LibraryAssetLite = {
  id: string;
  order_id?: string;
  created_at?: string;
  rights_start_at: string;
  rights_end_at: string;
  rights_expired: boolean;
  meta: { ad_id: string | null } | null;
  youtube: { video_id: string } | null;
  creator_display_name?: string | null;
  source_channel?: string | null;
};

export type OrderFacts = {
  package_snapshot: Record<string, unknown> | null;
  video: {
    delivered_at: string;
    play_url: string | null;
    watermarked?: boolean;
    preview?: "ready" | "preparing" | "failed" | "unavailable" | null;
    preview_unavailable_reason?: "file_type" | "not_built" | null;
  } | null;
  video_count: number;
};

export type BriefFacts = {
  business_name: string;
  evidence: Array<{ claim?: unknown; source?: unknown }>;
  rationale: string | null;
};

export type CardTarget =
  | { kind: "drawer"; name: DrawerName; params?: DrawerParams }
  | { kind: "channel"; slug: string; drawer?: DrawerName; params?: Record<string, string> }
  | { kind: "push"; assetId: string; push: "meta" | "youtube" }
  | { kind: "download"; assetId: string }
  | { kind: "hide" };

export type CardButton = { label: string; target: CardTarget; icon?: "edit" | "check" };

export type CreatorCard = {
  id: string;
  kind: string;
  isNew?: boolean;
  title: string;
  lead: string;
  why: string[];
  preview?: { business: string; title: string; angle: string | null; hook: string | null };
  media?: { caption: string; label: string; url: string | null; watermarked?: boolean; waiting?: boolean };
  pane?: { caption: string; rows: Array<[string, string]>; note?: string; muted?: string[] };
  bookPane?: boolean;
  applicantsOf?: string;
  primary: CardButton;
  secondary?: CardButton[];
  dismiss?: "Reject" | "Not now";
  dismissForDays?: number;
};

const DAY_MS = 86_400_000;
export const READY_CARD_DAYS = 30;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const fromWord = (snap: Record<string, unknown> | null | undefined) =>
  snap?.booked_from === "brief_applicant" ? "brief" : "package";

export function rightsDays(a: Pick<LibraryAssetLite, "rights_start_at" | "rights_end_at">): number | null {
  const d = Math.round((Date.parse(a.rights_end_at) - Date.parse(a.rights_start_at)) / DAY_MS);
  return Number.isFinite(d) && d > 0 ? d : null;
}

function rightsLine(a: LibraryAssetLite, order: OrderFacts | null): string {
  const d = rightsDays(a);
  const who = a.creator_display_name;
  const base = d ? `${d} days` : `until ${shortDay(a.rights_end_at)}`;
  return who && order ? `${base}, from ${who}'s ${fromWord(order.package_snapshot)}` : base;
}

export function assetIsReady(a: LibraryAssetLite, now: Date): boolean {
  if (a.rights_expired || a.meta?.ad_id) return false;
  const since = Date.parse(a.created_at ?? a.rights_start_at);
  return Number.isFinite(since) && now.getTime() - since <= READY_CARD_DAYS * DAY_MS;
}

function openBrief(b: HumanBrief): boolean {
  return !b.closed_at && b.status !== "filled" && b.status !== "cancelled";
}

export function sourcePage(evidence: BriefFacts["evidence"]): string | null {
  for (const e of evidence) {
    const s = typeof e.source === "string" ? e.source : "";
    const m = s.match(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)]*)?)/i);
    if (m) return m[1].replace(/^www\./i, "").replace(/\/$/, "");
  }
  return null;
}

export function postBriefCard(b: HumanBrief, facts: BriefFacts | null = null): CreatorCard {
  const n = b.deliverables ?? 1;
  const from = isCreatorVideoChannel(b.source_channel) ? CREATOR_VIDEO_CHANNEL_SPECS[b.source_channel] : null;
  const rows: Array<[string, string]> = [];
  if (b.format) rows.push(["Format", `${b.format}, ${plural(n, "video", "videos")}`]);
  if (!b.lane || b.lane === "ugc_video") rows.push(["Kind of job", "UGC video: you post it and run it as an ad"]);
  if (b.budget_usd) rows.push(["Budget", `${money(Math.round(b.budget_usd * 100))} per video`]);
  if (b.delivery_days) rows.push(["Deliver in", `${b.delivery_days} days after hire`]);
  if (b.answer_by) rows.push(["Answer by", shortDay(b.answer_by)]);
  if (b.applicant_cap) rows.push(["Applications", `Up to ${b.applicant_cap}`]);

  const byHand = Boolean(facts?.rationale && /^Written by hand/.test(facts.rationale));
  const byAgent = Boolean(facts?.rationale) && !byHand;
  const page = facts ? sourcePage(facts.evidence) : null;
  const who = byAgent
    ? from
      ? `Zavi wrote the brief for ${from.name}.`
      : page
        ? `Zavi wrote the brief from your page ${page}.`
        : "Zavi wrote the brief."
    : byHand
      ? from
        ? `You started this brief from ${from.name}.`
        : "You started this brief."
      : from
        ? `This brief is for ${from.name}.`
        : "This brief is ready to post.";
  const claims = (facts?.evidence ?? [])
    .map((e) => str(e.claim))
    .filter((c): c is string => c !== null)
    .slice(0, 2);
  const why = claims.length > 0 ? claims : byAgent && facts?.rationale ? [facts.rationale] : [];
  return {
    id: `ugc-post-brief-${b.id}`,
    kind: "Brief",
    isNew: true,
    title: `Post this brief to Zavi creators: ${b.title || "Untitled brief"}`,
    lead: `${who} Review it, then post it to creators on Zavi who match it.`,
    why,
    preview: { business: facts?.business_name ?? "", title: b.title || "Untitled brief", angle: b.angle ?? null, hook: b.hook ?? null },
    pane: { caption: "What creators will see", rows },
    primary: { label: "Review and post", target: { kind: "drawer", name: "brief", params: { brief: b.id } } },
    dismiss: "Reject",
  };
}

export function applicantsCard(b: HumanBrief): CreatorCard {
  const n = b.application_count ?? 0;
  const by = shortDay(b.answer_by);
  return {
    id: `ugc-applicants-${b.id}`,
    kind: "Applicants",
    title: `${plural(n, "creator", "creators")} applied to ${b.title || "your brief"}: pick one`,
    lead: by
      ? `Answer everyone by ${by}. The brief closes on that date, or sooner when you pay to hire someone.`
      : "The brief closes when you pay to hire someone.",
    why: ["Follower numbers are what each creator typed. Zavi does not check them."],
    applicantsOf: b.id,
    primary: { label: "See all applicants", target: { kind: "drawer", name: "applicants", params: { brief: b.id } } },
  };
}

export const BOOK_CARD: CreatorCard = {
  id: "ugc-book-direct",
  kind: "Book",
  title: "Or book a creator directly",
  lead: "Skip the brief: book a package at the price the creator set. Your card is held, and charged only if they accept within 72 hours.",
  why: [],
  bookPane: true,
  primary: { label: "Find creators", target: { kind: "drawer", name: "find" } },
};

function deliveredWhat(order: OrderFacts | null): string {
  if (!order) return "";
  const n = order.video_count || num(order.package_snapshot?.video_count) || 1;
  const platform = str(order.package_snapshot?.platform);
  return ` ${n}${platform ? ` ${platform}` : ""} ${n === 1 ? "video" : "videos"}`;
}

export function reviewCard(j: CreatorJobSummary, order: OrderFacts | null = null): CreatorCard {
  const name = firstName(j.creator_display_name || "Your creator");
  const used = j.revisions_used ?? 0;
  const by = j.deadline?.kind === "review" ? dayTimeUtc(j.deadline.deadline_at) : "";
  const snap = order?.package_snapshot ?? null;
  const secs = num(snap?.video_length_seconds);
  const days = num(snap?.ad_rights_days);
  const terms =
    secs && days
      ? `${secs} seconds, with ad rights for ${days} days from the ${fromWord(snap)}.`
      : days
        ? `Ad rights for ${days} days from the ${fromWord(snap)}.`
        : null;
  const delivered = order?.video ? `Delivered ${dayTimeUtc(order.video.delivered_at)}. ` : "";
  const secondary: CardButton[] =
    used < 2
      ? [{ label: `Request a change (round ${used + 1} of 2)`, target: { kind: "drawer", name: "review", params: { job: j.id } } }]
      : [];
  return {
    id: `ugc-review-${j.id}`,
    kind: "Review",
    title: `${name} delivered${deliveredWhat(order)}: review it`,
    lead: `${delivered}${by ? `If you don't answer by ${by}, the job closes as accepted.` : "Watch it, then approve it or ask for a change."}`,
    why: [
      ...(terms ? [terms] : []),
      "Zavi holds the money until you approve.",
      ...(order?.video?.watermarked || order?.video?.preview === "preparing" || order?.video?.preview === "failed"
        ? ["You are watching a watermarked preview. The original unlocks to download and post once you approve and pay."]
        : []),
      ...(used >= 2 ? ["Both change rounds are used. Approve it, or ask Zavi for help."] : []),
    ],
    media: order
      ? {
          caption:
            order.video?.preview === "unavailable"
              ? order.video.preview_unavailable_reason === "not_built"
                ? "Preview could not be built"
                : "No preview for this file"
              : order.video?.preview === "preparing" || order.video?.preview === "failed"
              ? "Preview being prepared"
              : `${secs ? `${secs}s video` : "Video"}${order.video?.watermarked ? " · watermarked preview" : ""}`,
          label: `${j.creator_display_name ?? "Creator"} video for ${j.title}`,
          url: order.video?.play_url ?? null,
          watermarked: order.video?.watermarked === true,
          waiting: order.video?.preview === "preparing" || order.video?.preview === "failed",
        }
      : undefined,
    primary: {
      label: `Approve and release ${money(j.money.price_cents)}`,
      target: { kind: "drawer", name: "review", params: { job: j.id } },
    },
    secondary,
  };
}

const WAITING = {
  awaiting_acceptance: { status: "Waiting for them to accept", lead: "They have not accepted yet." },
  in_progress: { status: "Making the video", lead: "They accepted and are making the video." },
  revision_requested: { status: "Making the change you asked for", lead: "They are making the change you asked for." },
} as const;
type WaitingStatus = keyof typeof WAITING;

export function isWaitingJob(j: Pick<CreatorJobSummary, "status" | "awaiting_creator">): boolean {
  return j.awaiting_creator || j.status in WAITING;
}

export function waitingDue(j: CreatorJobSummary): string {
  if (j.due_at) return shortDay(j.due_at);
  if (j.due_after_accept) return j.due_after_accept;
  if (j.product_needed && !j.product_received_at) return "Set once they receive your product";
  if (j.awaiting_creator || j.status === "awaiting_acceptance") return "7 days after they accept";
  return "Not set yet";
}

export function waitingCard(j: CreatorJobSummary): CreatorCard {
  const name = firstName(j.creator_display_name || "Your creator");
  if (j.extension_state === "requested" && j.status === "in_progress") {
    const asked = shortDay(j.extension_requested_due_at);
    return {
      id: `ugc-waiting-${j.id}`,
      kind: "More time",
      title: `${name} asked for more time: ${j.title}`,
      lead: "They asked to move the due date. Open the job to approve or decline it.",
      why: ["Zavi holds the money until you approve the video."],
      pane: {
        caption: "The job",
        rows: [
          ["Due now", waitingDue(j)],
          ["New date asked", asked || "In the job"],
          ["Price", money(j.money.price_cents)],
        ],
      },
      primary: { label: "Open job", target: { kind: "drawer", name: "job", params: { job: j.id } } },
    };
  }
  const awaiting = j.awaiting_creator || j.status === "awaiting_acceptance";
  const w = WAITING[(awaiting ? "awaiting_acceptance" : j.status) as WaitingStatus] ?? WAITING.in_progress;
  return {
    id: `ugc-waiting-${j.id}`,
    kind: "Waiting",
    title: `Waiting on ${name}: ${j.title}`,
    lead: w.lead,
    why: [
      awaiting
        ? "Your card is authorized but not charged yet. It is charged only if they accept."
        : "Zavi holds the money until you approve the video.",
    ],
    pane: {
      caption: "The job",
      rows: [
        ["Status", w.status],
        ["Due", waitingDue(j)],
        ["Price", money(j.money.price_cents)],
      ],
    },
    primary: { label: "Open job", target: { kind: "drawer", name: "job", params: { job: j.id } } },
  };
}

export const LATER = {
  campaign: "You pick it when you run it",
  adSet: "You pick the ad set when you approve",
  text: "You write it when you approve",
  inMeta: "Set it in Meta Ads Manager",
} as const;

export function useVideoCard(a: LibraryAssetLite, order: OrderFacts | null = null): CreatorCard {
  const name = firstName(a.creator_display_name || "Your creator");
  const spec = isCreatorVideoChannel(a.source_channel) ? CREATOR_VIDEO_CHANNEL_SPECS[a.source_channel] : null;
  if (!spec) {
    return {
      id: `ugc-use-${a.id}`,
      kind: "To do",
      title: `Use ${name}'s video in your ads`,
      lead: "You approved the video. Download it and run it where it fits.",
      why: [],
      pane: { caption: "Where it will run", rows: [["Ad rights", rightsLine(a, order)]] },
      primary: { label: "Done", icon: "check", target: { kind: "hide" } },
      secondary: [{ label: "Download the video", target: { kind: "download", assetId: a.id } }],
      dismiss: "Not now",
    };
  }
  const how =
    spec.push === "meta"
      ? `${spec.name} has a card to run it as a new ad, paused until you turn it on.`
      : spec.push === "youtube"
        ? `${spec.name} has a card to add it as a video ad once it is on your YouTube.`
        : `${spec.name} has a card to download it and ${spec.use === "ad" ? "upload it as a new ad" : "post it"}.`;
  return {
    id: `ugc-use-${a.id}`,
    kind: "To do",
    title: `Use ${name}'s video in ${spec.name}`,
    lead: `You approved the video. ${how}`,
    why: [],
    pane: {
      caption: "Where it will run",
      rows: [
        ["Channel", spec.name],
        ["Campaign", LATER.campaign],
        ["Placement", spec.placement],
        ["Ad rights", rightsLine(a, order)],
      ],
      muted: [LATER.campaign],
    },
    primary: { label: "Done", icon: "check", target: { kind: "hide" } },
    secondary: [{ label: `Open ${spec.name}`, target: { kind: "channel", slug: spec.slug } }],
    dismiss: "Not now",
  };
}

export function ugcHubCards(
  input: {
    briefs: HumanBrief[];
    jobs: CreatorJobSummary[];
    library: LibraryAssetLite[];
    bookable: number;
    briefFacts?: Record<string, BriefFacts>;
    orders?: Record<string, OrderFacts>;
  },
  now: Date = new Date(),
): CreatorCard[] {
  const open = input.briefs.filter(openBrief);
  const facts = input.briefFacts ?? {};
  const orders = input.orders ?? {};
  const answered = new Set(
    input.jobs.filter((j) => j.brief_id && (HIRED.has(j.status) || j.status === "awaiting_acceptance")).map((j) => j.brief_id as string),
  );
  const booked = input.jobs.some((j) => j.status !== "completed" && (HIRED.has(j.status) || j.status === "awaiting_acceptance"));
  const started = input.briefs.length > 0 || input.jobs.length > 0;
  return [
    ...input.jobs.filter((j) => j.status === "submitted").map((j) => reviewCard(j, orders[j.id] ?? null)),
    ...input.jobs.filter((j) => isWaitingJob(j) && j.extension_state === "requested" && j.status === "in_progress").map(waitingCard),
    ...input.library
      .filter((a) => assetIsReady(a, now))
      .map((a) => useVideoCard(a, a.order_id ? (orders[a.order_id] ?? null) : null)),
    ...open.filter((b) => !b.posted_at && !answered.has(b.id)).map((b) => postBriefCard(b, facts[b.id] ?? null)),
    ...open.filter((b) => b.posted_at && (b.application_count ?? 0) > 0).map(applicantsCard),
    ...(input.bookable > 0 && started && !booked ? [BOOK_CARD] : []),
    ...input.jobs
      .filter((j) => isWaitingJob(j) && !(j.extension_state === "requested" && j.status === "in_progress"))
      .map(waitingCard),
  ];
}

export function onePerKind<T extends { kind: string }>(cards: T[]): { shown: T[]; rest: T[] } {
  const seen = new Set<string>();
  const shown: T[] = [];
  const rest: T[] = [];
  for (const c of cards) {
    if (seen.has(c.kind)) rest.push(c);
    else {
      seen.add(c.kind);
      shown.push(c);
    }
  }
  return { shown, rest };
}

const HIRED = new Set(["in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute", "completed"]);

export function ugcHubNumbers(input: {
  briefs: HumanBrief[];
  jobs: CreatorJobSummary[];
  library: LibraryAssetLite[];
  orders?: Record<string, OrderFacts>;
}): Array<{ key: string; value: number | null; unit: string | null; unmeasured?: string }> {
  const orders = input.orders ?? {};
  const hired = input.jobs.filter((j) => HIRED.has(j.status));
  const creators = new Set(hired.map((j) => j.creator_slug ?? j.creator_display_name ?? j.id));

  const deliveredJobs = new Set<string>([
    ...input.library.map((a) => a.order_id ?? `asset:${a.id}`),
    ...input.jobs.filter((j) => j.status === "submitted").map((j) => j.id),
  ]);
  let videos: number | null = 0;
  for (const id of deliveredJobs) {
    const n = orders[id]?.video_count;
    if (!n) {
      videos = null;
      break;
    }
    videos += n;
  }

  let spent: number | null = 0;
  for (const j of hired) {
    const refunded = j.closed_reason === "mediation_pay_part" ? j.refunded_cents : 0;
    if (typeof refunded !== "number") {
      spent = null;
      break;
    }
    spent += j.money.business_total_cents - refunded;
  }

  return [
    { key: "briefs_out", value: input.briefs.filter((b) => b.posted_at && openBrief(b)).length, unit: null },
    { key: "creators_hired", value: creators.size, unit: null },
    videos === null
      ? { key: "videos_delivered", value: null, unit: null, unmeasured: "Could not read every delivery just now." }
      : { key: "videos_delivered", value: videos, unit: null },
    spent === null
      ? { key: "spent", value: null, unit: "usd", unmeasured: "Could not read a refund just now." }
      : { key: "spent", value: spent / 100, unit: "usd" },
  ];
}

export type BudgetHint = {
  creator: string;
  human_member_id?: string;
  price_cents: number;
  package_title?: string | null;
  video_count?: number | null;
} | null;

export function perVideoCents(budget: NonNullable<BudgetHint>): number {
  const n = budget.video_count && budget.video_count > 1 ? budget.video_count : 1;
  return Math.round(budget.price_cents / n);
}

export const CREATOR_CARD_SNOOZE_DAYS = 14;

export function creatorBudgetSource(budget: BudgetHint): string | null {
  if (!budget) return null;
  const packageName = budget.package_title ? `"${budget.package_title}" package` : "package";
  const quantity = budget.video_count && budget.video_count > 1
    ? `${money(budget.price_cents)} for ${budget.video_count} videos, ${money(perVideoCents(budget))} each`
    : money(budget.price_cents);
  return `Example from the packages checked: ${budget.creator}'s ${packageName} (${quantity}), plus Zavi's ${BUSINESS_FEE_BPS / 100}% fee. This is a budget estimate; the creator you choose sets the final price. No creator has been selected or invited.`;
}

export function creatorCardChatDraft(slug: string, card: CreatorCard): string {
  const channel = CHANNELS.find(c => c.slug === slug)?.name ?? slug;
  return [
    `About "${card.title}" on ${channel}:`,
    card.lead,
    ...card.why,
    ...(card.pane?.rows.map(([label, value]) => `${label}: ${value}`) ?? []),
    card.pane?.note,
    card.preview ? `Brief: ${card.preview.title}\nAngle: ${card.preview.angle ?? "Not set"}\nHook: ${card.preview.hook ?? "Not set"}` : null,
    "",
    "My question: ",
  ].filter(line => line !== null && line !== undefined).join("\n");
}

export function getCreatorVideoCard(slug: CreatorVideoChannel, budget: BudgetHint): CreatorCard {
  const spec = CREATOR_VIDEO_CHANNEL_SPECS[slug];
  const rows: Array<[string, string]> = [
    ["Format", CREATOR_VIDEO_PREFILL.format],
    ["For", spec.placement],
    ["Ad rights", `${CREATOR_VIDEO_PREFILL.ad_rights_days} days`],
  ];
  rows.push(["Budget estimate", budget ? `Around ${money(perVideoCents(budget))} per video, plus ${BUSINESS_FEE_BPS / 100}% fee` : "Choose a budget in the brief"]);
  return {
    id: `${slug}-get-creator-video`,
    kind: "Brief",
    title: `Create a video brief for ${spec.placement.replace(/^Your /, "your ")}`,
    lead: `${spec.use === "post" ? `Explore a creator video to post on ${spec.placement.replace(/^Your /, "your ")}.` : "Explore a creator video for this placement."} Open the UGC brief editor with the format, placement and rights filled in. Add or review the angle and hook before publishing. No payment or booking yet.`,
    why: [
      "Saving or publishing a brief does not charge you. You choose a creator and review their price before hiring.",
      "After hire, payment is held while you review the video. If you do not approve or ask for changes within 72 hours of delivery, the work is accepted automatically and the creator is paid 10 days later.",
    ],
    pane: {
      caption: "Brief starting points",
      rows,
      note: creatorBudgetSource(budget) ?? "A package estimate is unavailable. Set your budget in the brief; the creator's final price plus Zavi's fee is shown before hire.",
    },
    primary: { label: "Create video brief", target: { kind: "channel", slug: "ugc", drawer: "brief", params: { from: slug } } },
    dismiss: "Not now",
    dismissForDays: CREATOR_CARD_SNOOZE_DAYS,
  };
}

export function videoReadyCard(slug: CreatorVideoChannel, a: LibraryAssetLite, order: OrderFacts | null = null): CreatorCard {
  const spec = CREATOR_VIDEO_CHANNEL_SPECS[slug];
  const full = a.creator_display_name || "Your creator";
  const name = firstName(full);
  const verb = spec.use === "ad" ? "run it as an ad" : "post it";
  const lead =
    spec.push === "meta"
      ? `You approved ${full}'s video in UGC. Approve opens the ad form: pick the ad set and Zavi creates the ad in Meta, paused until you turn it on.`
      : spec.push === "youtube"
        ? `You approved ${full}'s video in UGC. Upload it to your YouTube, paste the link, and Zavi proposes the video ad for you to approve.`
        : spec.use === "ad"
          ? `You approved ${full}'s video in UGC. Download it and upload it as a new ad in ${spec.placement}.`
          : `You approved ${full}'s video in UGC. Download it and post it on ${spec.placement.replace(/^Your /, "your ")}.`;
  const secs = num(order?.package_snapshot?.video_length_seconds);
  const rows: Array<[string, string]> =
    spec.push === "meta"
      ? [
          ["Campaign", LATER.adSet],
          ["Placement", spec.placement],
          ["Primary text", LATER.text],
          ["Headline", LATER.inMeta],
          ["Button", LATER.inMeta],
          ["Starts", "Paused"],
        ]
      : [["Placement", spec.placement]];
  return {
    id: `${slug}-ready-${a.id}`,
    kind: spec.use === "ad" ? "Ad" : "Post",
    isNew: true,
    title: `${name}'s video is ready: ${verb}`,
    lead,
    why: [`Ad rights: ${rightsLine(a, order)}.`],
    media: { caption: secs ? `${secs}s video` : "Video", label: `${full} video`, url: order?.video?.play_url ?? null },
    pane: {
      caption: spec.push ? "The ad it will create" : "Where it goes",
      rows,
      muted: [LATER.adSet, LATER.text, LATER.inMeta],
    },
    primary: spec.push
      ? { label: "Approve", target: { kind: "push", assetId: a.id, push: spec.push } }
      : { label: "Download the video", target: { kind: "download", assetId: a.id } },
    dismiss: "Reject",
  };
}

export function videoChannelCards(
  slug: CreatorVideoChannel,
  input: { briefs: HumanBrief[]; library: LibraryAssetLite[]; budget: BudgetHint; orders?: Record<string, OrderFacts> },
  now: Date = new Date(),
): CreatorCard[] {
  const orders = input.orders ?? {};
  const ready = input.library.filter((a) => a.source_channel === slug && assetIsReady(a, now));
  const briefOut = input.briefs.some((b) => b.source_channel === slug && Boolean(b.posted_at) && openBrief(b));
  return [
    ...(briefOut ? [] : [getCreatorVideoCard(slug, input.budget)]),
    ...ready.map((a) => videoReadyCard(slug, a, a.order_id ? (orders[a.order_id] ?? null) : null)),
  ];
}

export const BOOST_CARD_CHANNELS = ["meta_ads", "tiktok_ads"] as const;
export type BoostCardChannel = (typeof BOOST_CARD_CHANNELS)[number];
export function isBoostCardChannel(slug: string): slug is BoostCardChannel {
  return (BOOST_CARD_CHANNELS as readonly string[]).includes(slug);
}

export function boostCreatorPostCard(slug: BoostCardChannel): CreatorCard {
  const meta = slug === "meta_ads";
  const code = meta ? "partnership ad code" : "Spark Ads code";
  const where = meta ? "Meta Ads Manager" : "TikTok Ads Manager";
  return {
    id: `${slug}-boost-creator-post`,
    kind: "How to",
    title: "Boost a creator's post",
    lead: `When a creator's post about you does well, run it as an ad from your ${meta ? "Meta" : "TikTok"} account, still under their name.`,
    why: ["Zavi does not create this ad or keep the code. You paste it into Ads Manager yourself."],
    pane: {
      caption: "Three steps",
      rows: [
        ["1. Ask", `Ask the creator for a ${code} for that post. They make it in their own app.`],
        ["2. Paste", `In ${where}, create an ad from an existing post and paste the code.`],
        ["3. Check", "Confirm the budget and audience there, then publish."],
      ],
      note: `Message to send: "Hi! Your post about us is doing great. Could you send me a ${code} for it so I can run it as an ad? It stays under your name."`,
    },
    primary: { label: "Done", target: { kind: "hide" } },
    dismiss: "Not now",
  };
}

export function staticCreatorCards(slug: string): CreatorCard[] {
  if (isBoostCardChannel(slug)) return [boostCreatorPostCard(slug)];
  return [];
}

export function cheapestFittingPackage<
  P extends { kind: string; price_cents: number; video_count?: number | null; video_length_seconds: number | null; ad_rights_days: number | null },
>(packages: P[]): P | null {
  let best: P | null = null;
  const each = (p: P) => Math.round(p.price_cents / (p.video_count && p.video_count > 1 ? p.video_count : 1));
  for (const p of packages) {
    if (p.kind !== "ugc_video" || p.price_cents <= 0) continue;
    if ((p.video_length_seconds ?? 0) < CREATOR_VIDEO_PREFILL.video_length_seconds) continue;
    if ((p.ad_rights_days ?? 0) < CREATOR_VIDEO_PREFILL.ad_rights_days) continue;
    if (!best || each(p) < each(best)) best = p;
  }
  return best;
}

export function orderFacts(detail: {
  package_snapshot: Record<string, unknown> | null;
  submissions: Array<{
    version: number;
    kind: string;
    created_at: string;
    play_url: string | null;
    watermarked?: boolean;
    preview?: "ready" | "preparing" | "failed" | "unavailable" | null;
    preview_unavailable_reason?: "file_type" | "not_built" | null;
  }>;
}): OrderFacts {
  const videos = detail.submissions.filter((s) => s.kind === "video");
  const top = videos.reduce((m, s) => Math.max(m, s.version), 0);
  const latest = videos.filter((s) => s.version === top);
  return {
    package_snapshot: detail.package_snapshot,
    video: latest[0]
      ? {
          delivered_at: latest[0].created_at,
          play_url: latest[0].play_url,
          watermarked: latest[0].watermarked,
          preview: latest[0].preview,
          preview_unavailable_reason: latest[0].preview_unavailable_reason ?? null,
        }
      : null,
    video_count: latest.length,
  };
}
