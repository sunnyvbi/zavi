
export const PICKED_MESSAGE_TYPE = 'zavi:element-picked';

export const PICKER_READY_TYPE = 'zavi:picker-ready';

export const PICKER_SET_TYPE = 'zavi:picker-set';

export function isPickerReadyMessage(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): boolean {
  if (!expectedOrigin || origin !== expectedOrigin) return false;
  if (typeof data !== 'object' || data === null) return false;
  return (data as Record<string, unknown>).type === PICKER_READY_TYPE;
}

export const MAX_SELECTOR_LENGTH = 200;

export type PickedElement = {
  selector: string;
  tag?: string;
};

const SAFE_SELECTOR_CHARS = /^[A-Za-z0-9_\-.#[\]=:()>+~* \t]+$/;

const COMBINATORS = new Set(['>', '+', '~']);

const KNOWN_TAGS = new Set([
  'a','abbr','address','article','aside','audio','b','blockquote','body','br','button',
  'canvas','caption','cite','code','col','colgroup','data','datalist','dd','del','details',
  'dfn','dialog','div','dl','dt','em','embed','fieldset','figcaption','figure','footer',
  'form','h1','h2','h3','h4','h5','h6','head','header','hgroup','hr','html','i','iframe',
  'img','input','ins','kbd','label','legend','li','main','map','mark','menu','meta','meter',
  'nav','noscript','object','ol','optgroup','option','output','p','picture','pre','progress',
  'q','rp','rt','ruby','s','samp','section','select','slot','small','source','span','strong',
  'sub','summary','sup','table','tbody','td','template','textarea','tfoot','th','thead',
  'time','tr','track','u','ul','var','video','wbr','svg','path','circle','rect','g',
]);

const TOKEN_PART = /^(\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+|\[[A-Za-z0-9_-]+(=[A-Za-z0-9_-]+)?\]|:[a-z-]+(\(\d+\))?|\*)/;

function isValidToken(token: string): boolean {
  if (COMBINATORS.has(token)) return true;

  let rest = token;

  const leadingWord = rest.match(/^[A-Za-z][A-Za-z0-9-]*/);
  if (leadingWord) {
    if (!KNOWN_TAGS.has(leadingWord[0].toLowerCase())) return false;
    rest = rest.slice(leadingWord[0].length);
  }

  while (rest.length > 0) {
    const part = rest.match(TOKEN_PART);
    if (!part) return false;
    rest = rest.slice(part[0].length);
  }

  return leadingWord !== null || token.length > 0;
}

const SAFE_TAG = /^[a-z][a-z0-9-]{0,30}$/;

export function isStructuralSelector(selector: unknown): selector is string {
  if (typeof selector !== 'string') return false;
  const trimmed = selector.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SELECTOR_LENGTH) return false;
  if (!SAFE_SELECTOR_CHARS.test(trimmed)) return false;
  const tokens = trimmed.split(/[ \t]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 8) return false;
  return tokens.every(isValidToken);
}

export function parsePickedMessage(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): PickedElement | null {
  if (!expectedOrigin || origin !== expectedOrigin) return null;
  if (typeof data !== 'object' || data === null) return null;

  const msg = data as Record<string, unknown>;
  if (msg.type !== PICKED_MESSAGE_TYPE) return null;

  const selector = msg.selector;
  if (!isStructuralSelector(selector)) return null;
  const trimmed = selector.trim();

  const rawTag = msg.tag;
  const tag =
    typeof rawTag === 'string' && SAFE_TAG.test(rawTag.toLowerCase())
      ? rawTag.toLowerCase()
      : undefined;

  return tag ? { selector: trimmed, tag } : { selector: trimmed };
}

export function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function composePickerPrefill(picked: PickedElement): string {
  const what = picked.tag ? `the <${picked.tag}> element` : 'the element';
  return `Change ${what} matching \`${picked.selector}\`: `;
}
