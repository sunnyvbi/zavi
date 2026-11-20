
const METRIC =
  "(?:sign-?ups?|users?|customers?|sellers?|buyers?|hosts?|bookings?|orders?|sales|revenue|leads?|traffic|conversions?|growth|retention|churn|activation|students?|subscribers?|downloads?|installs?)";

const GROWTH_TOPICS: RegExp[] = [
  /\b(?:growth|marketing|go[- ]to[- ]market|gtm)\s+(?:plan|strategy|roadmap)\b/i,
  /\bplan (?:my|our|the) (?:growth|week|month|quarter)\b/i,
  /\bnorth star\b/i,
  /\bwhat (?:should|are) (?:my|our) (?:growth )?(?:goals?|targets?)\b/i,
  new RegExp(`\\b(?:holding|holds|keeping|blocking|stopping|slowing)\\b[^.?!]{0,30}\\b(?:back|${METRIC})\\b`, "i"),
  /\b(?:bottleneck|binding constraint)\b/i,
  new RegExp(
    `\\bwhy (?:is|are|isn'?t|aren'?t)\\b[^.?!]{0,20}\\b${METRIC}\\b[^.?!]{0,20}\\b(?:flat|down|dropping|falling|stalled|stuck|slow|low|growing)\\b`,
    "i",
  ),
  /\bwhere (?:should|would) (?:we|i|you)\b[^.?!]{0,30}\b(?:spend|invest|focus)\b/i,
  /\bhow (?:much )?should (?:we|i) (?:spend|budget|split|allocate)\b/i,
  /\b(?:which|what)\b[^.?!]{0,25}\bchannels?\b[^.?!]{0,30}\b(?:should|would|next|first|best)\b/i,
  new RegExp(
    `\\b(?:how (?:do|can|should|would) (?:we|i)|what (?:should|would|can) (?:we|i|you)\\b[^.?!]{0,30}\\b(?:do|try))\\b[^.?!]{0,60}\\b(?:grow|get|win|reach|land|acquire|increase|double|improve)\\b[^.?!]{0,40}\\b${METRIC}\\b`,
    "i",
  ),
];

const STARTS_WITH_ORDER =
  /(?:^|[.?!;]\s+|\n\s*)(?:please\s+|can you\s+|could you\s+)?(?:pause|unpause|stop|launch|start|run|turn|increase|raise|lower|decrease|cut|set|change|update|create|make|build|post|publish|send|email|write|fix|deploy|schedule|add|remove|delete|approve|connect|mark)\b/i;

const OPERATOR_ONLY = /\b(?:notes?|brain|memory|campaigns?|ad ?sets?|creatives?)\b/i;

const MAX_QUESTION_CHARS = 300;

export function isGrowthQuestion(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > MAX_QUESTION_CHARS) return false;
  if (text.startsWith("@")) return false;
  if (STARTS_WITH_ORDER.test(text) || OPERATOR_ONLY.test(text)) return false;
  return GROWTH_TOPICS.some((topic) => topic.test(text));
}

export function askStartsOnGrowthAgent(message: string): boolean {
  return process.env.MCP_ASK_DIRECT_GROWTH !== "0" && isGrowthQuestion(message);
}
