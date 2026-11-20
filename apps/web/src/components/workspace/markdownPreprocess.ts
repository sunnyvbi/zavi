
const MODEL_XML_PATTERNS: RegExp[] = [
  /<\/?function_calls\s*>/gi,
  /<invoke\b[^>]*>/gi,
  /<\/invoke\s*>/gi,
  /<parameter\b[^>]*>/gi,
  /<\/parameter\s*>/gi,
  /<\/?tool_call\s*>/gi,
  /<\/?tool_response\s*>/gi,
  /<\/?antml:[a-z_-]+\b[^>]*>/gi,
  /<zavi-ui>[\s\S]*?(?:<\/zavi-ui>|$)/gi,
  /\{"name":"[a-z_-]+","arguments":\s*\{[^}]*\}\}/gi,
];

const BR_TAG = /<br\s*\/?>/gi;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function mapOutsideInlineCode(line: string, fn: (text: string) => string): string {
  let out = "";
  let text = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      text += line[i++];
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n++;
    const run = "`".repeat(n);
    let close = line.indexOf(run, i + n);
    while (close !== -1 && (line[close - 1] === "`" || line[close + n] === "`")) {
      close = line.indexOf(run, close + 1);
    }
    if (close === -1) {
      text += run;
      i += n;
      continue;
    }
    out += fn(text) + line.slice(i, close + n);
    text = "";
    i = close + n;
  }
  return out + fn(text);
}

const TABLE_DELIMITER =
  /^\s*(>\s*)*(\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?|\|\s*:?-+:?\s*\|)\s*$/;

function tableLines(lines: string[]): boolean[] {
  const inTable = lines.map(() => false);
  lines.forEach((line, d) => {
    if (!TABLE_DELIMITER.test(line) || d === 0 || !lines[d - 1].includes("|")) return;
    inTable[d - 1] = true;
    inTable[d] = true;
    for (let r = d + 1; r < lines.length && lines[r].trim() !== "" && lines[r].includes("|"); r++) {
      inTable[r] = true;
    }
  });
  return inTable;
}

export function rewriteHtmlBreaks(src: string): string {
  if (!/<br\s*\/?>/i.test(src)) return src;
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const inTable = tableLines(lines);
  let fence: { char: string; len: number } | null = null;
  return lines
    .map((line, i) => {
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}\\s*$`);
        if (close.test(line)) fence = null;
        return line;
      }
      const open = FENCE_OPEN.exec(line);
      if (open) {
        fence = { char: open[1][0], len: open[1].length };
        return line;
      }
      if (/^( {4}|\t)/.test(line)) return line;
      if (inTable[i]) {
        return mapOutsideInlineCode(line, (text) => text.replace(BR_TAG, " "));
      }
      return mapOutsideInlineCode(line, (text) => text.replace(BR_TAG, "\n")).replace(
        /\n[ \t]*$/,
        "",
      );
    })
    .join("\n");
}

export function stripModelControlXml(src: string): string {
  let out = src;
  for (const re of MODEL_XML_PATTERNS) out = out.replace(re, "");
  out = out.replace(/^ {0,3}(`{3,}|~{3,})(?:zavi-ui|json)?[ \t]*\n\s*^ {0,3}\1[ \t]*$/gim, "");
  out = rewriteHtmlBreaks(out);
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (/^\d+\.$/.test(out)) {
    out = out.replace(/^(\d+)\.$/, "$1\\.");
  }
  return out;
}
