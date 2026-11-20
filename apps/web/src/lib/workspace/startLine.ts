
type Topic = { re: RegExp; noun: string; verb: string };

const TOPICS: Topic[] = [
  { re: /\bgoogle ads?\b|\badwords\b|\bpmax\b|\bppc\b/, noun: "your Google Ads", verb: "Checking" },
  { re: /\bmeta\b(?! (description|tags?|titles?|data))|\bfacebook\b|\bfb\b/, noun: "your Meta ads", verb: "Looking at" },
  { re: /\btik ?tok\b/, noun: "TikTok", verb: "Looking at" },
  { re: /\blinkedin\b/, noun: "LinkedIn", verb: "Looking at" },
  { re: /\breddit\b/, noun: "Reddit", verb: "Looking at" },
  { re: /\binstagram\b|\binsta\b/, noun: "Instagram", verb: "Looking at" },
  { re: /\byoutube\b/, noun: "YouTube", verb: "Looking at" },
  { re: /\bseo\b|\brankings?\b|\bsearch results?\b|\bkeywords?\b/, noun: "your search rankings", verb: "Checking" },
  { re: /\bad ?spend\b|\bbudget\b|\bcac\b|\broas\b|\bcpc\b|\bcpa\b/, noun: "your ad spend", verb: "Checking" },
  { re: /\bemails?\b|\bnewsletters?\b|\bsubject lines?\b/, noun: "your email", verb: "Working on" },
  { re: /\bsign ?-?ups?\b|\bregistrations?\b|\bnew users\b/, noun: "your signups", verb: "Looking into" },
  { re: /\bfunnel\b|\bconversions?\b|\bcheckout\b|\bactivation\b/, noun: "your funnel", verb: "Looking into" },
  { re: /\bchurn\b|\bretention\b|\brepeat (buyers?|customers?|users?)\b/, noun: "retention", verb: "Looking into" },
  { re: /\bbookings?\b|\borders\b|\bsales\b|\brevenue\b|\bpurchases?\b|\bmrr\b/, noun: "your sales numbers", verb: "Pulling up" },
  { re: /\btraffic\b|\bvisitors?\b|\banalytics\b|\bga4\b/, noun: "your traffic", verb: "Looking at" },
  { re: /\bcompetitors?\b|\bcompetition\b/, noun: "your competitors", verb: "Looking into" },
  { re: /\bwebsite\b|\bsite\b|\blanding pages?\b|\bhome ?page\b|\bpage speed\b/, noun: "your site", verb: "Checking" },
  { re: /\bblog\b|\bcaptions?\b|\bposts?\b|\bdrafts?\b/, noun: "the draft", verb: "Working on" },
];

const PLAIN = ["Reading your question…", "Getting oriented…", "Lining things up…", "Getting started…"];

const QUEUED_PLAIN = "Getting started…";

function pick<T>(items: T[], text: string): T {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return items[h % items.length]!;
}

export function startLineFor(ask: string | null | undefined, queued: boolean): string {
  const text = (ask ?? "").toLowerCase();
  if (!text.trim()) return QUEUED_PLAIN;
  const topic = TOPICS.find((t) => t.re.test(text));
  if (topic) return queued ? `Getting started on ${topic.noun}…` : `${topic.verb} ${topic.noun}…`;
  return queued ? QUEUED_PLAIN : pick(PLAIN, text);
}
