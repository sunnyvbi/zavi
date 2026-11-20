
const EDIT_VERB =
  "(?:change|update|make|set|add|create|build|insert|introduce|remove|delete|drop|replace|rename|move|resize|restyle|redesign|redo|tweak|adjust|fix|swap|switch|increase|decrease|shrink|enlarge|hide|show|center|centre|align|reorder|rewrite|edit)";

const UI_NOUN =
  "(?:theme|colou?rs?|palette|font|typography|header|footer|hero|nav|navbar|menu|button|cta|section|page|layout|grid|background|logo|favicon|copy|headline|title|subtitle|tagline|banner|card|testimonial|spacing|padding|margin|border|radius|shadow|style|styles|styling|css|tailwind|dark mode|light mode|landing|homepage|home page|pricing section|hero section)";

const APP_SCOPE = "(?:the |my |our |this )?(?:site|website|web site|app|application|landing page|home ?page)";

const EDIT_PATTERNS: RegExp[] = [
  new RegExp(`\\b${EDIT_VERB}\\b[^.?!]{0,40}\\b${UI_NOUN}\\b`, "i"),
  new RegExp(`\\b${EDIT_VERB}\\b[^.?!]{0,40}\\b${APP_SCOPE}\\b`, "i"),
  new RegExp(`\\b${UI_NOUN}\\b[^.?!]{0,20}\\b(?:should|needs? to|must)\\b`, "i"),
  new RegExp(`^\\s*(?:please\\s+)?(?:${UI_NOUN})\\b[^.?!]{0,20}(?:please)?\\s*$`, "i"),
];

const QUESTION_PREFIX =
  /^\s*(?:what|who|whom|whose|when|where|why|which|how|is|are|was|were|do|does|did|can you tell|could you tell|tell me|show me|list|summari[sz]e|explain|draft|write me|give me an? (?:update|summary|report))\b/i;

const WORKSPACE_PHOTO_REF =
  /Use (?:this photo|these photos|the "[^"\n]*" photos) on the site:\s*\n?[^\n]*\/api\/public\/workspace-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//i;

export function carriesWorkspacePhotos(text: string | null | undefined): boolean {
  return !!text && WORKSPACE_PHOTO_REF.test(text);
}

export function isAppEditIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.slice(0, 4000).trim();
  if (!s) return false;
  if (carriesWorkspacePhotos(s)) return true;
  if (QUESTION_PREFIX.test(s)) return false;
  return EDIT_PATTERNS.some((re) => re.test(s));
}

const STRUCTURAL_SIGNAL =
  /\b(?:add|adds|adding|insert|create|remove|removes|removing|delete|deletes|drop|redesign|rebuild|restructure|reorder|rearrange|relayout)\b|\b(?:section|sections|page|pages|layout|grid|navbar|nav bar|theme|dark mode|light mode|hero section|pricing section|new (?:section|page|block|component))\b/i;

const SIMPLE_NOUN =
  /\b(?:colou?r|palette|font|typography|text|copy|wording|headline|heading|title|subtitle|tagline|label|caption|button|cta|link|url|logo|image|photo|picture|background)\b/i;

export function classifyAppEdit(text: string | null | undefined): "simple" | "structural" | "none" {
  if (!isAppEditIntent(text)) return "none";
  const s = (text as string).slice(0, 4000).trim();
  if (carriesWorkspacePhotos(s)) return "structural";
  if (STRUCTURAL_SIGNAL.test(s)) return "structural";
  if (SIMPLE_NOUN.test(s)) return "simple";
  return "structural";
}

const IMPERATIVE_EDIT = new RegExp(
  `^\\s*(?:(?:please|pls|ok(?:ay)?|now|also|and|then|so)[,\\s]+)*(?:(?:can|could|would|will) (?:you|we|u)\\s+(?:please\\s+)?)?${EDIT_VERB}\\b`,
  "i",
);

const OFF_SITE =
  /\b(?:ad|ads|advert|campaign|campaigns|newsletter|tweet|tweets|instagram|linkedin|facebook|tiktok|reddit|youtube|social post|social posts|press release|pitch deck|deck|investor|investors|report|reports|summary|brief|memo|cold email|email campaign|email blast|invoice|spreadsheet)\b/i;

const LETS_TALK =
  /^\s*(?:(?:ok(?:ay)?|so|now)[,\s]+)*let'?s\s+(?:discuss|talk|look|review|think|plan|check|see|chat|go over|brainstorm|figure|understand|dig|analy[sz]e)\b/i;

const POLITE_REQUEST = /^\s*(?:please\s+|pls\s+)?(?:(?:can|could|would|will) (?:you|we|u)\b|please\b)/i;

const CHANGE_OPENER =
  /^\s*(?:(?:please|pls|ok(?:ay)?|now|also|and|then|so)[,\s]+)*(?:(?:can|could|would|will) (?:you|we|u)\s+(?:please\s+)?)?(?:put|place)\b/i;
const SOFT_OPENER =
  /^\s*(?:(?:please|pls|ok(?:ay)?|now|also|and|then|so)[,\s]+)*(?:bring|use|include|feature|highlight|let'?s|lets)\b/i;
const CHANGE_WISH =
  /\b(?:i|we) (?:want|need|would like)\b|\b(?:i|we)'d like\b|\b(?:should|needs? to|must) (?:be|have|show|say|go|use|list|include|look)\b|\b(?:gone|instead)\s*[.!]?\s*$/i;
const CHANGE_STATEMENT = {
  test: (s: string): boolean =>
    CHANGE_OPENER.test(s) ||
    ((CHANGE_WISH.test(s) || SOFT_OPENER.test(s)) && new RegExp(`\\b(?:${SITE_PART.slice(3, -1)}|${UI_NOUN.slice(3, -1)})\\b|\\b${APP_SCOPE}\\b`, "i").test(s)),
};

const FOR_ME = /^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:make|create|build|draft|write|give|get|find|pull|put together)\s+(?:me|us)\b/i;

const SITE_PART =
  "(?:field|fields|form|forms|input|checkbox|dropdown|badge|badges|label|labels|icon|icons|image|images|photo|photos|picture|pictures|gallery|video|map|link|links|price|prices|item|items|product|products|listing|listings|faq|review|reviews|booking|bookings|order|orders|cart|checkout|signup|sign-up|sign up|login|log in|contact|address|phone|column|collection|table|text|wording|description|step|steps|tab|tabs|modal|popup|sidebar|slider|carousel|counter|timer|filter|search bar)";
const SITE_PART_EDIT = new RegExp(`\\b${EDIT_VERB}\\b[^.?!]{0,60}\\b${SITE_PART}\\b`, "i");

const MONEY = "(?:[$£€₹]\\s?\\d[\\d,]*(?:\\.\\d{1,2})?|\\d[\\d,]*(?:\\.\\d{1,2})?\\s?(?:dollars|usd|eur|euros|gbp|pounds|rupees|inr))";
const OWNER_PRICE = new RegExp(
  `\\b(?:our|my|the)\\s+(?:prices?|pricing|rates?|fees?)\\b[^?]{0,40}\\b(?:is|are|start|starts|run|from)\\b|\\b(?:we|i)\\s+charge\\b|${MONEY}\\s*(?:\\/|per|an?|each|for)\\b|\\b(?:costs?|starts? at|starting at|from)\\s+${MONEY}`,
  "i",
);
const OWNER_HOURS =
  /\b(?:our|my|the)\s+(?:business\s+|opening\s+|office\s+)?hours\b[^?]{0,20}\b(?:are|is)\b|\b(?:we(?:'re| are)|i(?:'m| am))\s+open\b|\bopen\s+(?:from\s+)?\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*(?:-|–|to|through|thru)\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^?]{0,20}\d/i;
const OWNER_AREA =
  /\b(?:we|i)\s+(?:serve|service|cover|work in|deliver to|operate in)\b|\b(?:our|my|the)\s+service\s+areas?\b[^?]{0,20}\b(?:is|are|includes?)\b/i;

export function isOwnerFactsStatement(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.slice(0, 4000).trim();
  if (!s || QUESTION_PREFIX.test(s) || /\?\s*$/.test(s)) return false;
  if (OFF_SITE.test(s) || FOR_ME.test(s) || LETS_TALK.test(s)) return false;
  return OWNER_PRICE.test(s) || OWNER_HOURS.test(s) || OWNER_AREA.test(s);
}

export function isSiteChatEditIntent(text: string | null | undefined): boolean {
  if (isAppEditIntent(text)) return true;
  if (!text) return false;
  const s = text.slice(0, 4000).trim();
  if (!s) return false;
  if (QUESTION_PREFIX.test(s)) return false;
  if (OFF_SITE.test(s) || FOR_ME.test(s) || LETS_TALK.test(s)) return false;
  if (/\?\s*$/.test(s) && !POLITE_REQUEST.test(s)) return false;
  return IMPERATIVE_EDIT.test(s) || SITE_PART_EDIT.test(s) || CHANGE_STATEMENT.test(s) || isOwnerFactsStatement(s);
}

const DATA_DELETE_VERB = "(?:delete|remove|drop|erase|wipe|clear|purge|get rid of|clean out|clean up)";
const DATA_NOUN =
  "(?:data|entries|entry|records|record|rows|row|submissions|submission|responses|answers|signups|sign-ups|leads|orders|bookings|messages|numbers|emails|addresses|column|columns|collection|collections|table|tables|database)";
const DATA_DELETE = new RegExp(
  `\\b${DATA_DELETE_VERB}\\b[^.?!]{0,50}\\b${DATA_NOUN}\\b|\\b${DATA_NOUN}\\b[^.?!]{0,20}\\b(?:deleted|removed|erased|wiped|cleared|purged)\\b`,
  "i",
);

export function isDestructiveDataEdit(text: string | null | undefined): boolean {
  if (!text) return false;
  return DATA_DELETE.test(text.slice(0, 4000));
}

export const DATA_DELETE_NOTE =
  "One thing first: your site's saved data can't be deleted by a change yet, so what visitors already sent stays stored. I can still take the field off the page and stop asking for it.";
