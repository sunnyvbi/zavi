
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";

export type SelectedElementScope = {
  selector: string;
  tag: string;
  text?: string;
  src?: string;
  path?: string;
};

export const MAX_SCOPE_SELECTOR = 400;
export const MAX_SCOPE_TEXT = 200;
export const MAX_SCOPE_PATH = 200;
export const MAX_SCOPE_SRC = 500;
export const MAX_SCOPED_MESSAGE = 2500;
const MAX_ENGINEER_REQUEST = 4000;

const SAFE_SELECTOR_CHARS = /^[A-Za-z0-9_\-.#[\]=:()>+~* ]+$/;
const MAX_SELECTOR_TOKENS = 16;
const COMBINATORS = new Set([">", "+", "~"]);
const KNOWN_TAGS = new Set([
  "a","abbr","address","article","aside","audio","b","blockquote","body","br","button",
  "canvas","caption","cite","code","col","colgroup","data","datalist","dd","del","details",
  "dfn","dialog","div","dl","dt","em","embed","fieldset","figcaption","figure","footer",
  "form","h1","h2","h3","h4","h5","h6","header","hgroup","hr","html","i","iframe",
  "img","input","ins","kbd","label","legend","li","main","map","mark","menu","meter",
  "nav","noscript","object","ol","optgroup","option","output","p","picture","pre","progress",
  "q","rp","rt","ruby","s","samp","section","select","slot","small","source","span","strong",
  "sub","summary","sup","table","tbody","td","template","textarea","tfoot","th","thead",
  "time","tr","track","u","ul","var","video","wbr","area","bdi","bdo","search","center",
  "font","big","tt","strike","marquee","dir","frame","frameset","acronym",
  "svg","path","circle","rect","g","line","polyline","polygon","ellipse","text","tspan",
  "textpath","use","defs","image","symbol","marker","mask","clippath","pattern","stop",
  "lineargradient","radialgradient","foreignobject","title","desc","filter",
  "a","animate","animatemotion","animatetransform","set","switch","view",
  "math","mi","mn","mo","ms","mtext","mspace","mrow","msup","msub","msubsup","mfrac","msqrt",
  "mroot","mstyle","mtable","mtr","mtd","munder","mover","munderover","menclose","mpadded",
  "mphantom","mglyph","semantics","annotation","mmultiscripts","mprescripts",
]);
const CUSTOM_ELEMENT = /^[a-z][a-z0-9]*-[a-z0-9-]+$/;
const TOKEN_PART = /^(\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+|\[[A-Za-z0-9_-]+(=[A-Za-z0-9_-]+)?\]|:[a-z-]+(\(\d+\))?|\*)/;

function isTagName(word: string): boolean {
  const w = word.toLowerCase();
  return KNOWN_TAGS.has(w) || CUSTOM_ELEMENT.test(w);
}

function isValidToken(token: string): boolean {
  if (COMBINATORS.has(token)) return true;
  let rest = token;
  const word = rest.match(/^[A-Za-z][A-Za-z0-9-]*/);
  if (word) {
    if (!isTagName(word[0])) return false;
    rest = rest.slice(word[0].length);
  }
  while (rest.length > 0) {
    const part = rest.match(TOKEN_PART);
    if (!part) return false;
    rest = rest.slice(part[0].length);
  }
  return true;
}

export function isRuntimeSelector(selector: string): boolean {
  if (!selector || selector.length > MAX_SCOPE_SELECTOR || !SAFE_SELECTOR_CHARS.test(selector)) return false;
  const tokens = selector.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.length <= MAX_SELECTOR_TOKENS && tokens.every(isValidToken);
}
const SAFE_TAG = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/%:@!$&'()*+,;=]*$/;

function oneLine(raw: string, max: number): string {
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseSelectedElement(raw: unknown): SelectedElementScope | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const r = raw as Record<string, unknown>;
  if (typeof r.selector !== "string" || typeof r.tag !== "string") return "invalid";
  const selector = r.selector.trim();
  const tag = r.tag.trim().toLowerCase();
  if (!isRuntimeSelector(selector)) return "invalid";
  if (!SAFE_TAG.test(tag) || !isTagName(tag)) return "invalid";
  const scope: SelectedElementScope = { selector, tag };

  if (r.text !== undefined && r.text !== null) {
    if (typeof r.text !== "string") return "invalid";
    const text = oneLine(sanitizeFetchedContent(r.text.slice(0, MAX_SCOPE_TEXT * 4)), MAX_SCOPE_TEXT);
    if (text) scope.text = text;
  }
  if (r.path !== undefined && r.path !== null) {
    if (typeof r.path !== "string") return "invalid";
    const path = r.path.trim();
    if (path.length > MAX_SCOPE_PATH || !SAFE_PATH.test(path)) return "invalid";
    scope.path = path;
  }
  if (r.src !== undefined && r.src !== null) {
    if (typeof r.src !== "string") return "invalid";
    const src = r.src.trim();
    if (src.length > MAX_SCOPE_SRC || /\s/.test(src)) return "invalid";
    const bare = src.split(/[?#]/, 1)[0]!;
    if (/^\/(?!\/)/.test(bare)) scope.src = bare;
    else if (/^https?:\/\/[^/]/i.test(bare)) {
      try {
        const url = new URL(bare);
        if (!url.username && !url.password) scope.src = bare;
      } catch {
      }
    }
  }
  return scope;
}

export function selectedElementBlock(scope: SelectedElementScope): string {
  const lines = [
    `Page: ${scope.path ?? "(unknown)"}`,
    `Element: <${scope.tag}>`,
    `CSS selector in the rendered page: ${scope.selector}`,
    ...(scope.text ? [`Its text: "${scope.text}"`] : []),
    ...(scope.src ? [`Image source: ${scope.src}`] : []),
  ];
  return [
    "The founder selected one element in the preview before writing the request above. Apply the change to that element (and only what it needs around it), unless the request clearly asks for more. Find it in the source by its text, image or position; the selector describes the rendered page, not a source file.",
    renderUntrustedBlock("selected_element", lines.join("\n")),
  ].join("\n");
}

export function scopedRequest(message: string, scope: unknown): string {
  const parsed = parseSelectedElement(scope);
  if (!parsed || parsed === "invalid") return message;
  const block = selectedElementBlock(parsed);
  const room = MAX_ENGINEER_REQUEST - block.length - 2;
  return `${message.length > room ? message.slice(0, Math.max(0, room)) : message}\n\n${block}`;
}
