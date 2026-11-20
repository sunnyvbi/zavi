
export type SplitReply = {
  own: string;
  quoted: string;
  forwarded: boolean;
};

const FORWARD_MARKERS: RegExp[] = [
  /^-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^begin forwarded message:?\s*$/i,
];

const QUOTE_MARKERS: RegExp[] = [/^-{2,}\s*original message\s*-{2,}\s*$/i, /^_{10,}\s*$/];

function isAttributionStart(lines: string[], i: number): boolean {
  const line = lines[i]!.trim();
  if (/^on\s.+\bwrote:\s*$/i.test(line)) return true;
  if (!/^on\s/i.test(line)) return false;
  const parts: string[] = [];
  for (let j = i; j < Math.min(lines.length, i + 3); j++) {
    const t = lines[j]!.trim();
    if (!t) break;
    parts.push(t);
    if (/\bwrote:\s*$/i.test(t)) break;
  }
  const joined = parts.join(" ");
  return /^on\s.+\bwrote:\s*$/i.test(joined) && joined.length < 400;
}

function isOutlookHeaderBlock(lines: string[], i: number): boolean {
  if (!/^\s*\*?from:\*?\s+\S/i.test(lines[i]!)) return false;
  const next = lines.slice(i + 1, i + 5).map((l) => l.trim());
  const hasWhen = next.some((l) => /^\*?(sent|date):\*?\s/i.test(l));
  const hasWho = next.some((l) => /^\*?(to|subject):\*?\s/i.test(l));
  return hasWhen && hasWho;
}

export function splitReplyText(body: string | null | undefined): SplitReply {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  let forwarded = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (FORWARD_MARKERS.some((re) => re.test(t))) {
      forwarded = true;
      cut = i;
      break;
    }
    if (
      isAttributionStart(lines, i) ||
      isOutlookHeaderBlock(lines, i) ||
      QUOTE_MARKERS.some((re) => re.test(t))
    ) {
      cut = i;
      break;
    }
  }
  if (!forwarded) {
    forwarded = lines.slice(cut).some((l) => FORWARD_MARKERS.some((re) => re.test(l.trim())));
  }

  const own: string[] = [];
  const quoted: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (i >= cut || /^\s*>/.test(l)) quoted.push(l);
    else own.push(l);
  }
  return { own: own.join("\n").trim(), quoted: quoted.join("\n").trim(), forwarded };
}
