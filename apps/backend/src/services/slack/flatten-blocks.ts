
type SlackBlockText = { type?: string; text?: string };

type SlackBlockElement = {
  type?: string;
  text?: string | SlackBlockText;
  elements?: SlackBlockElement[];
};

type SlackBlock = {
  type?: string;
  text?: SlackBlockText;
  fields?: SlackBlockText[];
  elements?: SlackBlockElement[];
};

type SlackAttachment = {
  text?: string;
  fallback?: string;
  blocks?: SlackBlock[];
};

function textOf(t: string | SlackBlockText | undefined): string {
  if (typeof t === "string") return t;
  if (t && typeof t.text === "string") return t.text;
  return "";
}

function flattenElement(el: SlackBlockElement): string {
  const parts: string[] = [];
  const own = textOf(el.text);
  if (own.trim()) parts.push(own);
  for (const child of el.elements ?? []) {
    const c = flattenElement(child);
    if (c.trim()) parts.push(c);
  }
  return parts.join("");
}

const MAX_FLAT = 8000;

export function hasStructuralBlocks(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (b) =>
      b &&
      typeof b === "object" &&
      typeof (b as SlackBlock).type === "string" &&
      (b as SlackBlock).type !== "rich_text",
  );
}

function flattenBlock(block: SlackBlock): string {
  const lines: string[] = [];
  switch (block.type) {
    case "header":
    case "section": {
      const main = textOf(block.text);
      if (main.trim()) lines.push(main);
      for (const f of block.fields ?? []) {
        const fv = textOf(f);
        if (fv.trim()) lines.push(fv);
      }
      break;
    }
    case "context": {
      for (const el of block.elements ?? []) {
        const ev = textOf(el.text);
        if (ev.trim()) lines.push(ev);
      }
      break;
    }
    case "rich_text": {
      for (const el of block.elements ?? []) {
        const rv = flattenElement(el);
        if (rv.trim()) lines.push(rv);
      }
      break;
    }
    default:
      break;
  }
  return lines.join("\n");
}

export function flattenSlackBlocks(
  blocks: unknown,
  attachments?: unknown,
): string {
  const out: string[] = [];
  let len = 0;
  const push = (s: string): boolean => {
    if (!s || !s.trim()) return true;
    out.push(s);
    len += s.length;
    return len < MAX_FLAT;
  };
  const safeBlock = (b: SlackBlock): string => {
    try {
      return flattenBlock(b);
    } catch {
      return "";
    }
  };

  if (Array.isArray(blocks)) {
    for (const b of blocks as SlackBlock[]) {
      if (!push(safeBlock(b))) break;
    }
  }
  if (len < MAX_FLAT && Array.isArray(attachments)) {
    outer: for (const a of attachments as SlackAttachment[]) {
      try {
        if (typeof a?.text === "string" && !push(a.text)) break;
        if (Array.isArray(a?.blocks)) {
          for (const b of a.blocks) {
            if (!push(safeBlock(b))) break outer;
          }
        }
      } catch {
      }
    }
  }
  return out
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
