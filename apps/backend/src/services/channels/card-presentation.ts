import { destinationFor, type ActionType } from "@zavi/shared";
import type { CardIntent } from "@/agents/lib/channel-recipe-step";
import { actionLabel } from "./action-label";
import { isAudienceList } from "./audience-list";
import type { SiteBuilder } from "./site-builder-markers";

const EMAIL_SEND_PLATFORM = "email_campaign";

export const CARD_KINDS = ["executes", "post", "plan", "message", "ad_manual", "copy_to_site", "task"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export type CardOwner = "zavi" | "founder" | "developer";

export type CardRole = { intent: CardIntent; owner: CardOwner };

export type CardPresentation = {
  card_kind: CardKind;
  primary_label: string;
  done_label: string;
  how_to: string[];
  intent: CardIntent;
  owner: CardOwner;
};

export type CardPresentationInput = {
  channelSlug: string;
  action_type: string;
  executable: boolean;
  deliverableKind: string | null;
  presentationType?: string;
  hasContent: boolean;
  deliverableContent?: string | null;
  stepBody: string | null;
  link: string | null;
  rows?: Array<{ item: string; before: string; after: string }> | null;
  execClass?: string | null;
  siteBuilder: SiteBuilder;
  structuredSteps?: readonly string[] | null;
  targetKind?: string | null;
  stepIntent?: CardIntent | null;
  stepOwner?: "founder" | "developer" | null;
  title?: string | null;
};

export const DONE_WORDS = [
  "I did this",
  "I posted it",
  "I sent it",
  "I published it",
  "I put it on my site",
  "I updated the page",
  "I created it",
  "Done",
  "Approved",
  "I sent it to dev",
  "I sent it to Zavi",
  "It works",
  "It's fixed",
  "I changed it",
  "I reached out",
  "I reviewed it",
  "Sent",
];

const INTENT_BY_TYPE: Record<ActionType, CardIntent> = {
  text_post: "create",
  image_post: "create",
  video_post: "create",
  reply: "create",
  page: "create",
  create_ad: "create",
  send_message: "reach_out",
  update_ad: "improve",
  pause_ad: "improve",
  fix: "improve",
  setup: "fix_setup",
  check: "review",
  other: "review",
};

const SETUP_TARGETS = new Set(["tracking", "account"]);
const SETUP_REPAIR_TYPES = new Set(["fix", "check", "setup", "other"]);

const TARGET_NOUN: Record<string, string> = {
  campaign: "campaign",
  ad_set: "ad set",
  ad: "ad",
  keyword: "keywords",
  audience: "audience",
  tracking: "tracking",
  account: "account",
  profile: "profile",
  page: "page",
  post: "post",
  thread: "thread",
};

const TASK_WORDS: Record<CardIntent, { primary: (noun: string | null) => string; done: string }> = {
  fix_setup: { primary: (n) => (n ? `Fix ${n}` : "Fix setup"), done: "It's fixed" },
  improve: { primary: (n) => (n ? `Update ${n}` : "Apply change"), done: "I changed it" },
  create: { primary: (n) => (n ? `Create ${n}` : "Create it"), done: "I created it" },
  reach_out: { primary: () => "Reach out", done: "I reached out" },
  review: { primary: (n) => (n ? `Review ${n}` : "Review it"), done: "I reviewed it" },
  answer: { primary: () => "Reply", done: "Sent" },
};
const VERIFY_WORDS = { primary: "Verify", done: "It works" };
const DEVELOPER_WORDS = { primary: "Send to dev", done: "I sent it to dev" };
const ZAVI_BUILDER_WORDS = { primary: "Send to Zavi", done: "I sent it to Zavi" };
const ZAVI_BUILDER_STEPS = [
  `Press ${ZAVI_BUILDER_WORDS.primary}. Your site was built with Zavi, so Website opens with this change written in.`,
  "Send it. Zavi's site builder makes the change on your site.",
  `Check the page, then press ${ZAVI_BUILDER_WORDS.done}.`,
];

export function cardRole(i: {
  action_type: string;
  executable: boolean;
  deliverableKind: string | null;
  targetKind?: string | null;
  stepIntent?: CardIntent | null;
  stepOwner?: "founder" | "developer" | null;
  siteBuilder: SiteBuilder;
}): CardRole {
  const type = i.action_type as ActionType;
  const intent: CardIntent = i.stepIntent
    ? i.stepIntent
    : i.targetKind && SETUP_TARGETS.has(i.targetKind) && SETUP_REPAIR_TYPES.has(type)
      ? "fix_setup"
      : i.deliverableKind && PLAN_KINDS.has(i.deliverableKind)
        ? "review"
        : (INTENT_BY_TYPE[type] ?? "review");
  const developerWork = i.stepOwner === "developer" || (!i.stepOwner && i.deliverableKind === "code");
  const owner: CardOwner = i.executable
    ? "zavi"
    : developerWork
      ? i.siteBuilder === "zavi"
        ? "zavi"
        : "developer"
      : (i.stepOwner ?? "founder");
  return { intent, owner };
}

const ASKS_FOR_ANSWER_RE =
  /\b(?:send (?:me|us|back|zavi)|bring me|reply with|tell (?:me|us|zavi)|let (?:me|us|zavi) know|paste (?:(?:it|them|the(?: [\w+-]+){1,4}) )?back|ask (?:the founder |you )?(?:whether|which)|ask (?:the founder|you) for|confirm (?:which|whether))\b/i;

const MANAGER_CHECK_RE = /^\s*check\b.*\bin (?:the |your )?(?:(?:LinkedIn|Meta|TikTok|Reddit|X|Google) )?(Campaign Manager|Ads Manager)\b/i;

export function managerCheck(title: string | null | undefined): string | null {
  return MANAGER_CHECK_RE.exec(title ?? "")?.[1] ?? null;
}

export function asksFounderForAnswer(i: {
  intent: CardIntent;
  hasContent: boolean;
  title: string | null | undefined;
  body: string | null | undefined;
  howTo?: readonly string[] | null;
}): boolean {
  if (i.intent !== "review" || i.hasContent || managerCheck(i.title)) return false;
  return ASKS_FOR_ANSWER_RE.test([i.title ?? "", i.body ?? "", ...(i.howTo ?? [])].join("\n"));
}

const INTERNAL_LINE_RES: readonly RegExp[] = [/^no em[- ]?dashes\b/i, /\bwithin (the )?limits\b/i, /\bcharacter count\b/i];
const isInternalLine = (line: string) => INTERNAL_LINE_RES.some((re) => re.test(line));

function structuredLines(steps: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of steps ?? []) {
    const line = cleanLine(String(raw).trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""));
    if (!line || isInternalLine(line) || out.includes(line)) continue;
    out.push(line);
  }
  return out;
}

function cleanLine(line: string): string {
  return line
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

const CROSS_REF = String.raw`\b(?:(?:step|action|card)\s+#?(\d+)\s+(?:above|below)|(?:action|card|recommendation)\s+#?(\d+))\b`;
const crossRefs = (text: string) => [...text.matchAll(new RegExp(CROSS_REF, "gi"))];

export function nameCrossRefs(text: string, titles: readonly string[]): string {
  if (typeof text !== "string" || !/\d/.test(text)) return text;
  const titleFor = (n: string | undefined): string | null => {
    const k = Number(n);
    return Number.isInteger(k) && k >= 1 && k <= titles.length ? titles[k - 1] : null;
  };
  const withoutBadParens = text.replace(/\s*\([^()]*\)/g, (paren) =>
    crossRefs(paren).some((m) => titleFor(m[1] ?? m[2]) === null) ? "" : paren,
  );
  return withoutBadParens.replace(new RegExp(CROSS_REF, "gi"), (whole: string, a?: string, b?: string) => {
    const title = titleFor(a ?? b);
    return title === null ? whole : `"${title}"`;
  });
}

const POST_TYPES = new Set(["text_post", "image_post", "video_post", "reply"]);
const PLAN_KINDS = new Set(["strategy"]);
const SITE_PAGE_CHANNELS = new Set([
  "seo",
  "geo",
  "blog",
  "sms",
  "email_marketing",
  "meta_ads",
  "google_ads",
  "youtube_ads",
  "tiktok_ads",
  "linkedin_ads",
  "reddit_ads",
  "x_ads",
  "chatgpt_ads",
]);
export const PROFILE_CHANNELS: ReadonlySet<string> = new Set([
  "x_organic",
  "linkedin_organic",
  "instagram_organic",
  "tiktok_organic",
  "youtube_organic",
  "pinterest_organic",
  "reddit_organic",
]);
const MESSAGE_KINDS = new Set(["email", "dm", "sms"]);
export const SITE_KINDS: ReadonlySet<string> = new Set(["article", "page_copy", "code", "proof_page"]);
const MAX_STEPS = 12;
const MAX_RUN_STEPS = 8;
const MAX_STEP_CHARS = 200;

export const AUDIENCE_REVIEW_WORDS = "Create audience";
export const AUDIENCE_REVIEW_STEPS: readonly string[] = [
  "Read both audiences on this card. Every field has a value, and the ones Zavi chose are marked as Zavi's suggestion.",
  `Press ${AUDIENCE_REVIEW_WORDS}. Zavi saves each audience to your LinkedIn ad account as a saved audience. Saving one spends nothing.`,
  "Zavi tells you anything LinkedIn could not match, and anything a saved audience cannot hold, such as an uploaded customer list.",
  "Use a saved audience when you set up a campaign in LinkedIn.",
];

export function cardPresentation(i: CardPresentationInput): CardPresentation {
  const dest = destinationFor(i.channelSlug);
  const kind = i.deliverableKind ?? null;
  const t = i.action_type;
  const runSteps = listLines(i.stepBody);
  const role = cardRole({
    action_type: t,
    executable: i.executable,
    deliverableKind: kind,
    targetKind: i.targetKind,
    stepIntent: i.stepIntent,
    stepOwner: i.stepOwner,
    siteBuilder: i.siteBuilder,
  });
  const structured = i.executable ? [] : structuredLines(i.structuredSteps);
  const done = (card: CardKind, primary: string, doneLabel: string, template: string[], lines: string[]) =>
    presentation(card, primary, doneLabel, template, lines, card === "executes" ? [] : structured, role);

  if (!i.executable && i.channelSlug === "chatgpt_ads" && i.presentationType === "campaign_draft") {
    return { card_kind: "task", primary_label: "Review and create", done_label: "Done", how_to: [
      "Review the researched campaign, targeting and ads.",
      "Choose the total budget, bid, target countries and any missing image URLs.",
      "Approve creation. Zavi creates the campaign, ad group and ads, all paused.",
    ], ...role };
  }

  if (!i.executable && i.channelSlug === "linkedin_ads" && kind === "list" && i.presentationType !== "campaign_draft" && isAudienceList(i.deliverableContent)) {
    return {
      card_kind: "task",
      primary_label: AUDIENCE_REVIEW_WORDS,
      done_label: "Done",
      how_to: [...AUDIENCE_REVIEW_STEPS],
      ...role,
      intent: "review",
    };
  }

  if (!i.executable && i.channelSlug === "linkedin_ads" && i.presentationType === "campaign_draft") {
    const closing = "Approve creation. Zavi creates the campaign paused, and nothing spends until you launch it.";
    return {
      card_kind: "task",
      primary_label: "Review and create",
      done_label: "Done",
      how_to: cap(structured.length ? [...structured, closing] : [
        "Press Review and create on this card.",
        "Pick the company post to promote, then confirm the audience, places, daily budget and bid.",
        closing,
      ]),
      ...role,
    };
  }

  if (i.executable && i.channelSlug === "generated_video") {
    return {
      card_kind: "executes",
      primary_label: "Approve",
      done_label: "Done",
      how_to: [
        "Read the script and the cost on this card.",
        "Press Approve. Zavi makes the video and it plays on this card.",
        "You are charged only when the video arrives. If it fails, nothing is charged.",
      ],
      ...role,
    };
  }

  if (i.executable && (i.channelSlug === "seo" || i.channelSlug === "geo")) {
    return {
      card_kind: "executes",
      primary_label: "Open pull request",
      done_label: "Done",
      how_to: [
        "Read the current and new values on this card.",
        "Press Open pull request. Zavi's engineer opens a pull request with exactly these changes.",
        "Review and merge it on GitHub. Nothing goes live until you do.",
      ],
      ...role,
    };
  }

  if (i.executable && i.channelSlug === EMAIL_SEND_PLATFORM) {
    const people = i.rows?.find((r) => r.item === "People")?.after.trim();
    const primary = people ? `Send to ${people} ${people === "1" ? "person" : "people"}` : "Send email";
    const tool = i.rows?.find((r) => r.item === "Sending with")?.after.trim() || "your email tool";
    return {
      card_kind: "executes",
      primary_label: primary,
      done_label: "Done",
      how_to: [
        "Read the email, the list and the number of people on this card.",
        `Press ${primary}. Zavi creates the email in ${tool} and sends it to that list.`,
        "The card shows how many people it went to, with a link, when it's done.",
      ],
      ...role,
    };
  }

  if (i.executable) {
    const primary = actionLabel({ action_type: t, title: "", rows: i.rows ?? null, exec_class: i.execClass ?? null });
    return done("executes", primary, "Done", [
      "Check the exact change on this card.",
      `Press ${primary}. Zavi makes the change in ${dest.name}.`,
      "The result shows on this card when it's done.",
    ], runSteps);
  }

  if (i.hasContent && (dest.publishes as readonly string[] | undefined)?.includes(t)) {
    const primary = `Post on ${dest.name}`;
    return done("post", primary, "Posted", [
      "Read it and edit anything you want first.",
      `Press Post. Zavi posts it from your connected ${dest.name} account.`,
    ], runSteps);
  }

  const composer = i.hasContent && POST_TYPES.has(t) && (dest.composer as readonly string[]).includes(t);
  if (composer) {
    const primary = `Post on ${dest.name}`;
    return done("post", primary, "I posted it", [
      `Press ${primary}. With your ${dest.name} account connected, it posts from that account. Not connected, ${dest.name} opens with the post filled in.`,
      `Connected and want a last edit or an image first? Press Open draft (under ···) and post it from ${dest.name}.`,
      "Posted it yourself? Come back and press I posted it.",
    ], runSteps);
  }

  if (kind === "proof_topics") {
    return { card_kind: "task", primary_label: "Write this page", done_label: "Writing it", how_to: [
      "Read Zavi's research on each topic and pick the page you want most.",
      "Press Write this page. Zavi writes it from the research in a few minutes.",
      "Fill any blank on the page Zavi writes, then add it to your site.",
    ], ...role };
  }

  if (!i.executable && i.channelSlug === "geo" && i.presentationType === "answer_check") {
    return { card_kind: "task", primary_label: "Check AI answers", done_label: "Checking", how_to: [
      "Press Check AI answers. Zavi asks the AI assistants the questions on this card.",
      "Results fill the GEO page as answers come in: who was named, and which sites were cited.",
      "Zavi's next GEO run reads them and picks the fix.",
    ], ...role };
  }

  if (!i.executable && i.channelSlug === "x_ads" && kind === "post" && i.presentationType === "x_organic_trial") {
    return { card_kind: "copy_to_site", primary_label: "Copy post", done_label: "I posted them", how_to: [
      "Open each of the three post tabs, copy its text, and publish it on your connected X account.",
      "Keep the saved text unchanged, or save your edits here before publishing so Zavi can match the posts.",
      "Zavi checks reply counts after all three posts have been live for three days. You do not need an ad budget yet.",
      "A post with replies can get a separate promotion proposal. Nothing is promoted without your approval.",
    ], ...role };
  }

  if (kind && PLAN_KINDS.has(kind) && (t === "check" || t === "other")) {
    return done("plan", "Approve plan", "Approved", [
      "Read the plan on this card.",
      "Want something different? Use Ask Zavi to change it.",
      "Press Approve plan. Zavi works from it from now on.",
    ], runSteps);
  }

  if (i.hasContent && (t === "send_message" || (kind && MESSAGE_KINDS.has(kind)))) {
    if (i.channelSlug === "email_marketing") {
      return done("message", "Copy email", "I sent it", [
        "Press Copy email.",
        "Open your email tool (Mailchimp, Klaviyo, or the one you use) and create a new campaign.",
        "Paste the email, pick who gets it, then send or schedule it.",
        "Come back and press I sent it.",
      ], runSteps);
    }
    if (kind === "email") {
      return done("message", "Open email", "I sent it", [
        "Press Open email. Your mail app opens with the subject and message filled in.",
        "Add the person's email address and send it.",
        "Come back and press I sent it.",
      ], runSteps);
    }
    return done("message", "Copy message", "I sent it", [
      "Press Copy message.",
      "Open the app you'll send it from and paste it to the person.",
      "Send it, then press I sent it.",
    ], runSteps);
  }

  if (i.hasContent && (t === "create_ad" || t === "update_ad")) {
    const where = dest.adsPath ?? dest.name;
    return done("ad_manual", "Copy ad", "I created it", [
      "Press Copy ad.",
      t === "update_ad" ? `In ${dest.name}, open the campaign or ad this card names.` : `In ${where}, start a new ad.`,
      t === "update_ad"
        ? "Change the fields shown on this card to the new values."
        : "Paste the headline, text and settings from this card into the matching fields.",
      t === "update_ad" ? "Save it, then press I created it." : "Publish it, then press I created it.",
    ], runSteps);
  }

  if (kind && SITE_KINDS.has(kind) && i.hasContent) {
    if (kind === "page_copy" && i.targetKind === "profile" && !PROFILE_CHANNELS.has(i.channelSlug)) {
      return done("copy_to_site", "Copy listing", "I created it", [
        "Press Copy listing.",
        "Open the site this card names and start a new listing or profile.",
        "Paste the name, description and category, and submit it.",
        "Come back and press I created it.",
      ], runSteps);
    }
    const primary =
      kind === "code" ? "Copy code" : kind === "page_copy" ? "Copy new text" : kind === "proof_page" ? "Copy page" : "Copy post";
    const doneLabel = kind === "article" || kind === "proof_page" ? "I put it on my site" : "I updated the page";
    const ownSite = kind !== "page_copy" || SITE_PAGE_CHANNELS.has(i.channelSlug);
    if (ownSite && i.siteBuilder === "zavi") return zaviBuilderCard({ ...role, owner: "zavi" });
    const steps =
      ownSite
        ? siteSteps(primary, kind, i.siteBuilder, doneLabel)
        : PROFILE_CHANNELS.has(i.channelSlug)
          ? [`Press ${primary}.`, `Open ${dest.app ?? dest.name} and find the text this card names.`, "Replace it with the new text and save.", `Come back and press ${doneLabel}.`]
          : [`Press ${primary}.`, "Put the new text where this card says it goes.", `Come back and press ${doneLabel}.`];
    return done("copy_to_site", primary, doneLabel, steps, runSteps);
  }

  if (POST_TYPES.has(t) && i.hasContent) {
    const app = dest.app ?? dest.name;
    return done("copy_to_site", "Copy post", "I posted it", [
      "Press Copy post.",
      `Open ${app} and start a new post.`,
      "Paste the text, add the image or video, and post it.",
      "Come back and press I posted it.",
    ], runSteps);
  }

  if (role.owner === "zavi") return zaviBuilderCard(role);
  const manager = i.executable || i.hasContent ? null : managerCheck(i.title);
  if (manager && role.owner === "founder") {
    return {
      card_kind: "task",
      primary_label: `Open ${manager}`,
      done_label: "Done",
      how_to: cap(structured.length ? structured : runSteps),
      ...role,
      intent: "review",
    };
  }
  if (role.intent === "answer" && role.owner === "founder") {
    const steps = structured.length ? structured : runSteps;
    return { card_kind: "task", primary_label: TASK_WORDS.answer.primary(null), done_label: TASK_WORDS.answer.done, how_to: cap(steps), ...role };
  }
  const noun = i.targetKind ? (TARGET_NOUN[i.targetKind] ?? null) : null;
  const verify = role.intent === "fix_setup" && t === "check";
  const words = TASK_WORDS[role.intent];
  const developer = role.owner === "developer";
  const doneLabel = developer ? DEVELOPER_WORDS.done : verify ? VERIFY_WORDS.done : words.done;
  const primary = developer
    ? DEVELOPER_WORDS.primary
    : i.link
      ? `Open ${dest.name}`
      : verify
        ? VERIFY_WORDS.primary
        : words.primary(noun);
  const steps = structured.length ? structured : runSteps;
  return { card_kind: "task", primary_label: primary, done_label: doneLabel, how_to: cap(steps), ...role };
}

function zaviBuilderCard(role: CardRole): CardPresentation {
  return {
    card_kind: "task",
    primary_label: ZAVI_BUILDER_WORDS.primary,
    done_label: ZAVI_BUILDER_WORDS.done,
    how_to: [...ZAVI_BUILDER_STEPS],
    ...role,
  };
}

const COPY_KINDS: ReadonlySet<CardKind> = new Set(["post", "message", "ad_manual", "copy_to_site"]);

const FINAL_ACTION_RE = /^(?:(?:then|and|now|finally),?\s+)?(send|post|publish|create|save)\w*\b/i;

function finalAction(step: string | undefined): string | null {
  return step ? (FINAL_ACTION_RE.exec(step)?.[1]?.toLowerCase() ?? null) : null;
}

function presentation(
  kind: CardKind,
  primary: string,
  doneLabel: string,
  template: string[],
  runSteps: string[],
  structured: string[],
  role: CardRole,
): CardPresentation {
  let steps: string[];
  if (structured.length === 0) {
    steps = [...template, ...runSteps];
  } else if (COPY_KINDS.has(kind)) {
    const first = template[0];
    const last = template[template.length - 1];
    const closing = template.length > 1 && last ? last : null;
    const lastAction = finalAction(structured[structured.length - 1]);
    const body = closing && lastAction !== null && lastAction === finalAction(closing)
      ? structured.slice(0, -1)
      : structured;
    steps = [
      ...(first && first.startsWith(`Press ${primary}`) ? [first] : []),
      ...body,
      ...(closing ? [closing] : []),
    ];
  } else {
    steps = structured;
  }
  return { card_kind: kind, primary_label: primary, done_label: doneLabel, how_to: cap(steps), ...role };
}

function cap(steps: string[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const c = s.length > MAX_STEP_CHARS ? `${s.slice(0, MAX_STEP_CHARS - 1).replace(/\s+\S*$/, "")}…` : s;
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

function siteSteps(primary: string, kind: string, builder: SiteBuilder, doneLabel: string): string[] {
  const finish = `Come back and press ${doneLabel}.`;
  if (kind === "code") {
    return [
      `Press ${primary}.`,
      "Send it to whoever edits your site's code, with this card's steps.",
      "Once it's live, check the page.",
      finish,
    ];
  }
  const page = kind === "page_copy";
  if (kind === "proof_page") {
    const add: Record<SiteBuilder, string> = {
      wordpress: "In WordPress, go to Pages › Add New.",
      webflow: "In Webflow, add a new page in the Designer.",
      shopify: "In Shopify admin, go to Online Store › Pages › Add page.",
      squarespace: "In Squarespace, go to Pages and press +.",
      wix: "In Wix, add a new page in the Editor.",
      framer: "In Framer, add a new page.",
      zavi: "Your site was built with Zavi: open Website in Zavi and ask it to add this page.",
      unknown: "Open your site's editor and add a new page at the address this card gives.",
    };
    const steps = [`Press ${primary}.`, add[builder]];
    if (builder === "unknown") steps.push("Coded site? Send it to your developer instead.");
    steps.push("Paste it, set the address and title this card gives, fill any [CONFIRM] slot, and publish.", finish);
    return steps;
  }
  const where: Record<SiteBuilder, string> = {
    wordpress: page ? "In WordPress, open Pages and edit the page this card names." : "In WordPress, go to Posts › Add New.",
    webflow: page
      ? "In Webflow, open the page in the Designer (or its CMS item)."
      : "In Webflow, open your blog's CMS collection and add a new item.",
    shopify: page
      ? "In Shopify admin, go to Online Store › Pages and open the page."
      : "In Shopify admin, go to Online Store › Blog posts › Add blog post.",
    squarespace: page ? "In Squarespace, go to Pages and edit the page." : "In Squarespace, open your blog page and press +.",
    wix: page ? "In Wix, open the page in the Editor." : "In Wix, go to Blog › Create New Post.",
    framer: page ? "In Framer, open the page." : "In Framer, open your blog's CMS collection and add an item.",
    zavi: "Your site was built with Zavi: open Website in Zavi and ask it to add this.",
    unknown: page
      ? "Open your site's editor and the page this card names (WordPress: Pages · Webflow: Designer · Shopify: Online Store › Pages · Squarespace/Wix: Pages)."
      : "Open your site's editor (WordPress: Posts › Add New · Webflow: CMS › new item · Shopify: Online Store › Blog posts · Squarespace/Wix: Blog › New post).",
  };
  const steps = [`Press ${primary}.`, where[builder]];
  if (builder === "unknown") steps.push("Coded site? Send it to your developer instead.");
  steps.push(page ? "Paste it over the old text, then publish the change." : "Paste it, add the images, preview, and publish.");
  steps.push(finish);
  return steps;
}

export function listLines(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!m) continue;
    const line = cleanLine(m[1]);
    if (!line || /^[a-z0-9]+(_[a-z0-9]+)+$/.test(line) || isInternalLine(line)) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length >= MAX_RUN_STEPS) break;
  }
  return out;
}
