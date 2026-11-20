
export const PUBLISH_REFUSED_TEST_MARKER = "publish_refused_test_marker" as const;
export const PUBLISH_REFUSED_BLANKS = "publish_refused_blanks" as const;

export const MEDIA_LINK_NOT_PUBLIC = "media_link_not_public" as const;
export const ACCOUNT_CHECK_FAILED = "account_check_failed" as const;
export const MEDIA_LINK_NOT_PUBLIC_MESSAGE =
  "Zavi couldn't make a public link to the image, so nothing was sent to the platform. Propose it again.";
export const ACCOUNT_CHECK_FAILED_MESSAGE =
  "Zavi could not re-check your connected account, so nothing was posted. Propose it again.";

export const PUBLISH_REFUSAL_CODES: readonly string[] = [
  PUBLISH_REFUSED_TEST_MARKER,
  PUBLISH_REFUSED_BLANKS,
  MEDIA_LINK_NOT_PUBLIC,
  ACCOUNT_CHECK_FAILED,
];

const DEV_TEST_MARKERS: readonly { label: string; re: RegExp }[] = [
  { label: "(Zavi dev)", re: /\(\s*zavi\s+dev\s*\)/i },
  { label: "Local test from", re: /\blocal test from\b/i },
  { label: "[test]", re: /\[\s*test\s*\]/i },
  { label: "[dev]", re: /\[\s*dev\s*\]/i },
  { label: "Delete me after", re: /\bdelete me after\b/i },
  { label: "lorem ipsum", re: /\blorem ipsum\b/i },
];

export type PublishTextRefusal =
  | { code: typeof PUBLISH_REFUSED_TEST_MARKER; marker: string; field: string; message: string }
  | { code: typeof PUBLISH_REFUSED_BLANKS; blanks: string[]; field: string; message: string };

const MAX_BLANK = 80;
const MAX_LABELLED = 400;
const LABELLED = /^[A-Z][A-Z ]*:/;
const FILL_IN = /^fill[- ]?in\s*:/i;
const FIELD_NAMES = new Set([
  "NAME", "FIRST", "LAST", "CITY", "STATE", "COMPANY", "BRAND", "EMAIL", "PHONE", "DATE", "TIME", "PRICE", "AMOUNT", "URL", "LINK", "ADDRESS",
  "CONFIRM", "TBD", "TBA", "TK", "INSERT", "YOUR",
]);

const BRACKET = /\[([^\[\]]{1,400})\]/g;
const MERGE_TAG = /\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g;

const FLAIR = new Set([
  "discussion", "question", "help", "advice", "meta", "news", "update", "serious",
  "request", "review", "guide", "tip", "tips", "poll", "rant", "showcase",
  "feedback", "resource", "announcement", "story", "hiring", "launch", "show", "ask",
  "oc", "ama", "psa", "til", "eli5",
]);

function isFlair(s: string, at: number): boolean {
  return at === 0 && FLAIR.has(s.toLowerCase());
}

function isBlank(inner: string, before: string, after: string, at: number): boolean {
  const s = inner.trim();
  if (!s || !/[a-z]/i.test(s)) return false;
  if (LABELLED.test(s) || FILL_IN.test(s) ? s.length > MAX_LABELLED : s.length > MAX_BLANK || s.includes("\n")) return false;
  if (isFlair(s, at)) return false;
  if (/^x$/i.test(s)) return false;
  if (after.startsWith("(") || after.startsWith("[") || /^\s*(->|→)\s*\S/.test(after)) return false;
  if ((before === "" || before === "\n") && /^:\s*\S/.test(after)) return false;
  if (before === "[" || before === "]" || before === "/" || /\w/.test(before)) return false;
  if (/^["{\d]/.test(s)) return false;
  if (/^[0-9a-f]{6,}$/i.test(s) && /\d/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 1 && !s.split("_").some((w) => FIELD_NAMES.has(w))) return false;
  return true;
}

const CODE_KINDS = new Set(["code"]);

export function findBlanks(text: string | null | undefined, kind?: string | null): string[] {
  if (!text || (kind && CODE_KINDS.has(kind))) return [];
  const found: { at: number; blank: string }[] = [];
  for (const m of text.matchAll(BRACKET)) {
    const at = m.index ?? 0;
    const before = at > 0 ? text[at - 1] : "";
    const after = text.slice(at + m[0].length, at + m[0].length + 12);
    if (isBlank(m[1], before, after, at)) found.push({ at, blank: m[0] });
  }
  for (const m of text.matchAll(MERGE_TAG)) {
    if (/[a-z]/i.test(m[1])) found.push({ at: m.index ?? 0, blank: m[0] });
  }
  found.sort((x, y) => x.at - y.at);
  return Array.from(new Set(found.map((f) => f.blank)));
}

const SHOWN = 40;
const clip = (raw: string) => {
  const b = raw.replace(/\s+/g, " ");
  return b.length > SHOWN ? `${b.slice(0, SHOWN - 1).trimEnd()}…]` : b;
};

export const UNEDITABLE_FIELD_HINT =
  "The title can't be edited here: reject this post and ask Zavi to redo it with the blanks filled.";

const EDITABLE_FIELD = /^(?:text|thread\[\d+\])$/;

const NON_TEXT_KEYS = new Set(["file", "url", "image_url", "video_url", "photo_urls", "video_path"]);

function* textLeaves(value: unknown, path: string): Generator<{ field: string; text: string }> {
  if (typeof value === "string") {
    yield { field: path, text: value };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* textLeaves(value[i], `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NON_TEXT_KEYS.has(k)) continue;
      yield* textLeaves(v, path ? `${path}.${k}` : k);
    }
  }
}

export function checkPublishText(content: unknown): PublishTextRefusal | null {
  const leaves = [...textLeaves(content, typeof content === "string" ? "text" : "")];
  const pinTitleEditable = !!content && typeof content === "object" && "board_id" in content;
  for (const { field, text } of leaves) {
    for (const m of DEV_TEST_MARKERS) {
      if (m.re.test(text)) {
        return {
          code: PUBLISH_REFUSED_TEST_MARKER,
          marker: m.label,
          field,
          message:
            `The post contains the test marker "${m.label}" (in ${field}). ` +
            "Test copy never goes out on a real account. Edit the text and approve again.",
        };
      }
    }
  }
  const blanks: string[] = [];
  let firstField = "";
  let uneditable = false;
  for (const { field, text } of leaves) {
    const found = findBlanks(text);
    if (!found.length) continue;
    if (!firstField) firstField = field;
    if (!EDITABLE_FIELD.test(field) && !(pinTitleEditable && field === "title")) uneditable = true;
    for (const b of found) if (!blanks.includes(b)) blanks.push(b);
  }
  if (blanks.length) {
    const list = `Fill before publishing: ${blanks.map(clip).join(", ")}`;
    return {
      code: PUBLISH_REFUSED_BLANKS,
      blanks,
      field: firstField,
      message: uneditable
        ? `${list}. ${UNEDITABLE_FIELD_HINT}`
        : list,
    };
  }
  return null;
}
