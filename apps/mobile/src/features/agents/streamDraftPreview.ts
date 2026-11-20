const ENVELOPE_TAG = /<[a-z][a-z0-9_-]*(?:[\s/>])/;
const TRAILING_PARTIAL_TAG = /<(?:[a-z][a-z0-9_-]*)?$/;

export function streamDraftPreview(text: string): string {
  if (!text) return "";
  let out = "";
  let rest = text;

  for (;;) {
    const i = rest.search(ENVELOPE_TAG);
    if (i === -1) return (out + rest.replace(TRAILING_PARTIAL_TAG, "")).trim();

    out += rest.slice(0, i);
    const open = rest.slice(i);
    const name = /^<([a-z][a-z0-9_-]*)/.exec(open)?.[1];
    const tagEnd = open.indexOf(">");

    if (!name || tagEnd === -1) return out.trim();

    if (open[tagEnd - 1] === "/") {
      rest = open.slice(tagEnd + 1);
      continue;
    }

    const close = `</${name}>`;
    const ci = open.indexOf(close, tagEnd);
    if (ci === -1) return out.trim();

    if (out.trim()) out += "\n\n";
    rest = open.slice(ci + close.length);
  }
}
