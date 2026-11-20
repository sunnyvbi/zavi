
export function extractDeliverables(task: string): string[] {
  if (typeof task !== "string" || task.trim().length === 0) return [];
  const lines = task.split("\n");
  const bullets = lines
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^([-*]|\d+[.)])\s+/, "").trim());
  if (bullets.length >= 2) return dedupe(bullets);
  const andSplit = task
    .split(/\band\b|\bAND\b/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 3 &&
        /\b(add|wire|surface|update|fix|create|expose|register|remove|migrate|implement)\b/i.test(
          s,
        ),
    );
  return andSplit.length >= 2 ? dedupe(andSplit) : [];
}

export function verificationCoversAll(
  task: string,
  renderedMarkdown: string,
): boolean {
  const deliverables = extractDeliverables(task);
  if (deliverables.length < 2) return true;
  const section = extractVerificationSection(renderedMarkdown);
  if (!section) return false;
  const lower = section.toLowerCase();
  const defers =
    /(deferred|not done|not yet|partial|follow-?up|out of scope|did not|haven't|未)/i.test(
      section,
    );
  return deliverables.every((d) => {
    if (defers) return true;
    const kw = keywordsOf(d);
    if (kw.length === 0) return true;
    const need = kw.length >= 2 ? 2 : 1;
    const hits = kw.filter((k) => lower.includes(k)).length;
    return hits >= need;
  });
}

function extractVerificationSection(rm: string): string | null {
  if (typeof rm !== "string") return null;
  const m = /^#{1,4}\s+verification\b/im.exec(rm);
  if (!m) return null;
  const rest = rm.slice(m.index + m[0].length);
  const next = /^#{1,4}\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function keywordsOf(d: string): string[] {
  return d.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g)?.slice(0, 4) ?? [];
}
function dedupe(a: string[]): string[] {
  return [...new Set(a.map((s) => s.trim()))];
}
