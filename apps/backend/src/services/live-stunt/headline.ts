
const MAX = 120;

const BRANDS: [RegExp, string][] = [
  [/\bchat\s?gpt\b/gi, "ChatGPT"],
  [/\blinked\s?in\b/gi, "LinkedIn"],
  [/\btik\s?tok\b/gi, "TikTok"],
  [/\byou\s?tube\b/gi, "YouTube"],
  [/\bfacebook\b/gi, "Facebook"],
  [/\binstagram\b/gi, "Instagram"],
  [/\breddit\b/gi, "Reddit"],
  [/\bgoogle\b/gi, "Google"],
  [/\bmeta(?=\s+ads?\b)/gi, "Meta"],
];

export function brandCase(s: string): string {
  return BRANDS.reduce((out, [re, name]) => out.replace(re, name), s);
}
const hasBrand = (s: string) => BRANDS.some(([re]) => new RegExp(re.source, "i").test(s));

const TASK_LINE = /^Started (?!an? )([^:]{1,40}):/;

function taskHeadline(label: string): string {
  const words = label.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const named = hasBrand(words) ? brandCase(words) : words.split(" ").map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ");
  return `Started work on ${named}.`;
}

function cutUnclosedQuote(s: string): string {
  let cut = -1;
  if ((s.match(/"/g) ?? []).length % 2 === 1) cut = s.lastIndexOf('"');
  const curlyOpen = s.lastIndexOf("“");
  if (curlyOpen > s.lastIndexOf("”")) cut = cut === -1 ? curlyOpen : Math.min(cut, curlyOpen);
  let open = -1;
  for (let k = 0; k < s.length; k++) {
    if (s[k] !== "'" && s[k] !== "‘" && s[k] !== "’") continue;
    const before = k === 0 ? " " : s[k - 1];
    const after = k + 1 < s.length ? s[k + 1] : " ";
    if (open === -1 && s[k] !== "’" && /[\s(]/.test(before) && /\S/.test(after)) open = k;
    else if (open !== -1 && /\S/.test(before) && /[\s.,;:!?)]/.test(after)) open = -1;
  }
  if (open !== -1) cut = cut === -1 ? open : Math.min(cut, open);
  return cut === -1 ? s : s.slice(0, cut);
}

function finish(s: string): string {
  const t = s.replace(/[\s:;,(\-–—]+$/, "").trim();
  if (!t) return "";
  return /[.!?…"”')]$/.test(t) ? t : `${t}.`;
}

export function plainHeadline(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  if (!s) return "";
  const task = s.match(TASK_LINE);
  if (task) return taskHeadline(task[1]);
  if (s.length > MAX) {
    const first = s.match(/^[^.!?]*[.!?]/)?.[0]?.trim();
    s = first && first.length <= MAX ? first : `${s.slice(0, MAX - 1).replace(/\s+\S*$/, "")}…`;
  }
  s = cutUnclosedQuote(s);
  return finish(brandCase(s));
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export type HeadlineFacts = {
  work: string[];
  channels: string[];
  spent_usd: number | null;
  bookings: number | null;
};

export function countHeadline(f: Pick<HeadlineFacts, "spent_usd" | "bookings">): string {
  const facts: string[] = [];
  if (f.spent_usd !== null) facts.push(`spent ${usd(f.spent_usd)} on ads`);
  if (f.bookings !== null) facts.push(`got ${f.bookings} ${f.bookings === 1 ? "booking" : "bookings"}`);
  return facts.length ? `${facts.join(" and ").replace(/^./, (c) => c.toUpperCase())} that day.` : "";
}

export const isCountHeadline = (h: string) => /^(Spent \$[\d,]+ on ads( and got \d+ bookings?)?|Got \d+ bookings?) that day\.$/.test(h);

export function distinctHeadline(headline: string, earlier: readonly string[], f: HeadlineFacts): string {
  const taken = new Set(earlier.map(key));
  if (!taken.has(key(headline))) return headline;
  const ok = (h: string) => !!h && !taken.has(key(h));
  for (const w of f.work) {
    const h = plainHeadline(w);
    if (ok(h)) return h;
  }
  const counts = countHeadline(f);
  if (ok(counts)) return counts;
  if (f.channels.length) {
    const h = `Kept working on ${f.channels.join(" and ")}.`;
    if (ok(h)) return h;
  }
  return "Followed up on the previous day's work.";
}

export function isOwnerHeadline(edited: string | null, draft: string | null): boolean {
  const e = (edited ?? "").replace(/\s+/g, " ").trim();
  if (!e) return false;
  const d = (draft ?? "").trim().slice(0, 200).replace(/\s+/g, " ").trim();
  return e !== d;
}

export function shownHeadline(edited: string | null, draft: string | null): string {
  return isOwnerHeadline(edited, draft) ? (edited ?? "").trim() : plainHeadline(draft ?? "");
}
