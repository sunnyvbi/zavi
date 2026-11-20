
import type { ChannelSettingField } from "./channelSettings";
import { UGC_SETTINGS } from "./ugc";
import { REDDIT_SETTINGS } from "./reddit";

export type NumberField = {
  kind: "number";
  id: string;
  label: string;
  help: string;
  min?: number;
  max?: number;
  prefix?: string;
  suffix?: string;
  writesTo?: string;
};

export type TextField = { kind: "text"; id: string; label: string; help: string; placeholder?: string; writesTo?: string };

export type AnySettingField = ChannelSettingField | NumberField | TextField;

export const WRITES_ELSEWHERE_FIELD_IDS = ["budget", "cadence", "autonomy"] as const;

export function elsewhereText(field: AnySettingField): string | null {
  const writesTo = "writesTo" in field ? field.writesTo : undefined;
  if (!writesTo && !(WRITES_ELSEWHERE_FIELD_IDS as readonly string[]).includes(field.id)) return null;
  if (writesTo === "channel.monthly_budget") {
    return "Saved with the channel's budget, where pacing reads it. Changing it here would make a second copy.";
  }
  return "This value lives in another store and is not saved from this tab.";
}

export const CHANNEL_SETTINGS: Record<string, AnySettingField[]> = {
  google_ads: [
    {
      kind: "list",
      id: "negatives",
      label: "Negative keywords",
      help: "Searches Zavi will not let your ads show on. It never removes one you added.",
      itemTypes: ["phrase", "exact", "broad"],
    },
    {
      kind: "number",
      id: "budget",
      label: "Monthly budget",
      help: "The ceiling Zavi paces against. It will not propose past it.",
      prefix: "$",
      suffix: "a month",
      writesTo: "channel.monthly_budget",
    },
    {
      kind: "number",
      id: "tcpa",
      label: "Target cost per conversion",
      help: "What a booked job is worth paying for. Every proposal is judged against this.",
      prefix: "$",
      suffix: "per conversion",
    },
    {
      kind: "toggle",
      id: "maypause",
      label: "Pause a losing campaign",
      help: "Whether Zavi may propose a pause at all.",
      on: "Yes, propose it — with the numbers",
      off: "No, never propose a pause",
    },
    {
      kind: "text",
      id: "landing_page",
      label: "Where a click should land",
      help: "The page Zavi checks against when it reads a campaign.",
      placeholder: "https://example.com/book",
    },
  ],
  tiktok_ads: [
    {
      kind: "text",
      id: "landing_page",
      label: "Where a TikTok tap lands",
      help: "Tell Zavi which page a paid tap should land on. It goes to the next run, which checks that page for the TikTok pixel and reads it the way a phone would.",
      placeholder: "https://example.com/book",
    },
    {
      kind: "text",
      id: "tiktok_handle",
      label: "Your TikTok handle",
      help: "The public account Zavi reads your posts from, to find a Spark Ads candidate. Reading these posts does not spend money.",
      placeholder: "@yourbrand",
    },
  ],
  linkedin_ads: [
    {
      kind: "number",
      id: "deal_value",
      label: "What one new customer is worth in year one",
      help: "What one new customer pays you in year one. Zavi uses it as the break-even check against LinkedIn's own published test floors. It is not a budget and it spends nothing.",
      prefix: "$",
      suffix: "in year one",
      min: 0,
    },
    {
      kind: "text",
      id: "landing_page",
      label: "Where a LinkedIn click lands",
      help: "Tell Zavi which page a paid click should land on. It goes to the next run, which reads that page and looks for the Insight Tag.",
      placeholder: "https://example.com/demo",
    },
  ],
  reddit_ads: [
    {
      kind: "toggle",
      id: "comments_on",
      label: "Can someone answer comments on an ad?",
      help: "Reddit ads default to comments off. Say yes only if a real person will be there to reply.",
      on: "Yes — someone will answer them",
      off: "No — keep comments off",
    },
    {
      kind: "text",
      id: "landing_page",
      label: "Where a Reddit click lands",
      help: "Tell Zavi which page a paid click should land on. It goes to the next run, which reads that page and judges whether it matches the ad's register.",
      placeholder: "https://example.com/start",
    },
  ],
  x_ads: [
    {
      kind: "text",
      id: "landing_page",
      label: "Where an X ad click lands",
      help: "Tell Zavi which page a paid click should land on. The next run reads it before picking which posts to promote.",
      placeholder: "https://example.com/start",
    },
  ],
  chatgpt_ads: [
    {
      kind: "text",
      id: "landing_page",
      label: "Where a click should land",
      help: "The public page customers should reach. Zavi checks this page and uses it in your campaign draft.",
      placeholder: "https://example.com/book",
    },
    {
      kind: "number",
      id: "tcpa",
      label: "Target cost per customer",
      help: "Your target acquisition cost. This guides recommendations; approve the campaign's lifetime budget separately before saving.",
      prefix: "$",
      suffix: "per customer",
    },
  ],
  linkedin_organic: [
    {
      kind: "text",
      id: "profile_url",
      label: "The LinkedIn profile that posts",
      help: "The /in/ page you want audited and written for. It goes to the next run, which will not guess a profile from a name search.",
      placeholder: "https://www.linkedin.com/in/your-handle/",
    },
    {
      kind: "list",
      id: "targets",
      label: "Accounts to comment under",
      help: "Accounts whose posts you want comments drafted under. Pick ones your buyer already reads, not a direct competitor. They go to the next run.",
    },
  ],
  reddit_organic: REDDIT_SETTINGS,
  instagram_organic: [
    {
      kind: "text",
      id: "handle",
      label: "Your Instagram account",
      help: "The account this channel is about. Type the username on its own, with no @. It goes to the next run.",
      placeholder: "yourbrand",
    },
    {
      kind: "list",
      id: "competitors",
      label: "Accounts in your category",
      help: "Accounts in your category worth reading for what is earning views. They go to the next run, which only compares you to accounts it actually read.",
    },
  ],
  tiktok_organic: [
    {
      kind: "text",
      id: "username",
      label: "Your TikTok username",
      help: "Just the username, without the @ and not the profile URL — that is the form the lookup takes. Without it every run has to find you by search first, and may read someone else.",
      placeholder: "yourcompany",
    },
    {
      kind: "choice",
      id: "on_camera",
      label: "Who can be on camera",
      help: "The shot list is written for whoever can actually film. A correct “nobody” is a real answer here, not a failure.",
      options: [
        { value: "face", label: "Someone will appear on camera" },
        { value: "hands_voice", label: "Hands and voiceover only, no face" },
        { value: "nobody", label: "Nobody can film right now" },
      ],
    },
    {
      kind: "text",
      id: "destination",
      label: "Where a viewer should land",
      help: "Only the bio link is clickable on TikTok. This is the page the bio and the pinned comment point at.",
      placeholder: "https://example.com/book",
    },
  ],
  pinterest_organic: [
    {
      kind: "text",
      id: "handle",
      label: "Your Pinterest account",
      help: "The username after pinterest.com/. It goes to the next run.",
      placeholder: "yourbrand",
    },
    {
      kind: "list",
      id: "competitors",
      label: "Pinterest accounts in your niche",
      help: "Usernames worth comparing against. The next run reads their recent pins and only compares you to accounts it actually read.",
    },
  ],
  youtube_organic: [
    {
      kind: "text",
      id: "handle",
      label: "Your YouTube handle",
      help: "Your @handle, not the full URL — that is the form the lookup takes. Leave it blank and every run has to find you by search.",
      placeholder: "@yourcompany",
    },
    {
      kind: "choice",
      id: "on_camera",
      label: "Who can be on camera",
      help: "Answer it and the plan stops guessing. Zavi writes a no-face version either way, so “nobody” narrows the plan rather than ending it.",
      options: [
        { value: "face", label: "Someone will appear on camera" },
        { value: "voice_screen", label: "Voiceover and screen recording only" },
        { value: "nobody", label: "Nobody can appear on camera" },
      ],
    },
    {
      kind: "list",
      id: "queries",
      label: "Questions you want to rank for",
      help: "Typed the way a viewer would type them into YouTube search, not the way you would write a headline.",
    },
  ],
  ugc: UGC_SETTINGS,
  email_marketing: [
    {
      kind: "list",
      id: "segments",
      label: "Who's on your list",
      help: "The audiences you send to. Saved and handed to the next run.",
      itemTypeOptions: {
        unsetLabel: "What they agreed to: not stated",
        label: (item) => `What ${item} agreed to`,
        options: [
          { value: "marketing_optin", label: "Asked for marketing email" },
          { value: "transactional", label: "Customers — transactional only" },
          { value: "imported", label: "Imported or bought — no opt-in we know of" },
        ],
      },
    },
  ],
  sms: [
    {
      kind: "choice",
      id: "number_route",
      label: "The number you'd text from",
      help: "Saved and handed to the next run. Which route you are on decides what has to clear before a text is delivered.",
      options: [
        { value: "none", label: "None yet" },
        { value: "toll_free", label: "Toll-free, verified" },
        { value: "ten_dlc", label: "10DLC, registered" },
      ],
    },
    {
      kind: "list",
      id: "moments",
      label: "Moments worth a text",
      help: "A booked time, a state change someone is waiting on, a deadline they chose. If it would matter as much read three hours later, it is an email.",
    },
  ],
};

export const ACCOUNT_FIELD: Record<string, string> = {
  instagram_organic: "handle",
  tiktok_organic: "username",
  linkedin_organic: "profile_url",
  pinterest_organic: "handle",
  youtube_organic: "handle",
};

export function settingsFor(slug: string, accountLinked = false): AnySettingField[] | null {
  const hidden = accountLinked ? ACCOUNT_FIELD[slug] : undefined;
  const fields = (CHANNEL_SETTINGS[slug] ?? []).filter((f) => !hidden || f.id !== hidden);
  return fields.length ? fields : null;
}
