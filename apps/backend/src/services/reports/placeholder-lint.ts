
const STUB_LINE_RE = /^\s*\d+\.\s*\d*\s*[—–-]\s*$/;

const HEADING_RE = /^\s{0,3}#{1,6}\s/;

export function isPlaceholderStubLine(line: string): boolean {
  return STUB_LINE_RE.test(line.replace(/[*_`]/g, ""));
}

function isEmptyBody(text: string): boolean {
  return /^[\s—–-]*$/.test(text);
}

export type PlaceholderLintFlags = {
  stub_lines: number;
  empty_sections: number;
};

export function lintMarkdownPlaceholders(md: string): {
  text: string;
  flags: PlaceholderLintFlags;
} {
  const flags: PlaceholderLintFlags = { stub_lines: 0, empty_sections: 0 };
  const lines = (md ?? "").split("\n").filter((line) => {
    if (isPlaceholderStubLine(line)) {
      flags.stub_lines++;
      return false;
    }
    return true;
  });

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (HEADING_RE.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !HEADING_RE.test(lines[j])) j++;
      if (isEmptyBody(lines.slice(i + 1, j).join("\n"))) {
        flags.empty_sections++;
        i = j;
        continue;
      }
      out.push(...lines.slice(i, j));
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, flags };
}

export type LintableSection = {
  heading: string;
  body_markdown: string;
  preformatted?: string;
  table?: { columns: string[]; rows: string[][] };
};

export function lintArtifactSections<S extends LintableSection>(
  sections: readonly S[],
): { sections: S[]; flags: PlaceholderLintFlags } {
  const flags: PlaceholderLintFlags = { stub_lines: 0, empty_sections: 0 };
  const kept: S[] = [];
  for (const sec of sections) {
    const r = lintMarkdownPlaceholders(sec.body_markdown);
    flags.stub_lines += r.flags.stub_lines;
    flags.empty_sections += r.flags.empty_sections;
    const hasOtherContent =
      sec.table !== undefined || (sec.preformatted ?? "").trim().length > 0;
    if (!hasOtherContent && isEmptyBody(r.text)) {
      flags.empty_sections++;
      continue;
    }
    kept.push(r.text === sec.body_markdown ? sec : { ...sec, body_markdown: r.text });
  }
  return { sections: kept, flags };
}
