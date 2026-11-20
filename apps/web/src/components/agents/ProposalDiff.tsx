
export type ProposalChange = { before: string; after: string };

export function parseProposalChanges(raw: unknown): ProposalChange[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      const o = c as { before?: unknown; after?: unknown };
      return {
        before: typeof o?.before === "string" ? o.before : "",
        after: typeof o?.after === "string" ? o.after : "",
      };
    })
    .filter((c) => c.before || c.after);
}

export function ProposalDiff({
  changes,
  max = 3,
}: {
  changes: ProposalChange[] | null | undefined;
  max?: number;
}) {
  const list = Array.isArray(changes) ? changes : [];
  if (list.length === 0) return null;
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  return (
    <div className="space-y-1.5">
      {shown.map((c, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-lg border border-[#ececec] text-[13px] leading-snug"
        >
          <div className="flex gap-2 bg-[#fdf3f3] px-3 py-1.5 text-[#9a4b4b]">
            <span className="select-none font-semibold">−</span>
            <span className="min-w-0 break-words line-through decoration-[#d8a3a3]">
              {c.before || "(empty)"}
            </span>
          </div>
          <div className="flex gap-2 bg-[#f1faf3] px-3 py-1.5 text-[#3f7a4f]">
            <span className="select-none font-semibold">+</span>
            <span className="min-w-0 break-words">{c.after || "(removed)"}</span>
          </div>
        </div>
      ))}
      {extra > 0 ? (
        <div className="text-[12px] text-[#8a8a8a]">
          +{extra} more change{extra === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}
