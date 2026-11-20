
export type AffinityAnchor = {
  slug: string;
  label: string;
  body: string;
};

export type AffinityNote = {
  id: string;
  title: string;
  body: string;
  tags: string[];
};

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","for","on","with","at","by",
  "is","are","was","were","be","been","being","have","has","had","do","does",
  "did","this","that","these","those","i","you","he","she","it","we","they",
  "as","if","not","no","yes","so","than","then","there","when","where","why",
  "how","what","which","who","whom","whose","its","their","our","my","your",
  "us","them","me","also","just","only","very","more","most","some","any",
  "all","each","every","into","from","about","up","down","out","over","under",
  "again","further","once","here","very","s","t","can","will","would","should",
  "could","may","might","must","ll","re","ve","d","m",
]);

export function tokenize(text: string): Set<string> {
  const set = new Set<string>();
  const words = text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  for (const w of words) if (!STOPWORDS.has(w)) set.add(w);
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function assignNotesToAnchors(
  anchors: AffinityAnchor[],
  notes: AffinityNote[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (anchors.length === 0) return out;
  const anchorTokens = anchors.map((a) =>
    tokenize(`${a.label} ${a.slug} ${a.body}`),
  );
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i];
    const noteToks = tokenize(`${n.title} ${n.body} ${(n.tags ?? []).join(" ")}`);
    let bestIdx = -1;
    let bestScore = 0;
    for (const t of n.tags ?? []) {
      const idx = anchors.findIndex((a) => a.slug === t.toLowerCase());
      if (idx >= 0) {
        bestIdx = idx;
        bestScore = 1;
        break;
      }
    }
    if (bestIdx < 0) {
      for (let j = 0; j < anchors.length; j += 1) {
        const score = jaccard(noteToks, anchorTokens[j]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }
    }
    if (bestIdx < 0) {
      bestIdx = i % anchors.length;
    }
    out.set(n.id, anchors[bestIdx].slug);
  }
  return out;
}
