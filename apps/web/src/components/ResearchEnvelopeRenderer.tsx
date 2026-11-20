"use client";

import type { ReactNode } from "react";
import { Markdown } from "@/components/workspace/Markdown";

type Source = {
  n: number;
  title: string;
  url: string;
  accessed_at: string;
  source_type?: string;
};

type Chip = {
  tier: "validated" | "inferred" | "assumption" | "high-risk";
  text: string;
  supporting_source_indices: number[];
};

type Block = { type: string; [k: string]: unknown };

export type ResearchEnvelope =
  | {
      kind: "clarification";
      questions: { question: string; why: string }[];
    }
  | {
      kind: "report";
      template: string;
      title: string;
      subtitle?: string;
      query: string;
      blocks: Block[];
      lenses: unknown[];
      sources: Source[];
      validation: Chip[];
      failed_lenses: string[];
      generated_at: string;
    };

const TIER_STYLE: Record<Chip["tier"], string> = {
  validated: "bg-green-100 text-green-800",
  inferred: "bg-blue-100 text-blue-800",
  assumption: "bg-amber-100 text-amber-800",
  "high-risk": "bg-red-100 text-red-800",
};

export function ResearchEnvelopeRenderer({
  envelope,
}: {
  envelope: ResearchEnvelope;
}) {
  if (envelope.kind === "clarification") {
    return (
      <div className="space-y-3">
        <p className="text-base text-gray-600">
          A few questions to sharpen the research:
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          {envelope.questions.map((q, i) => (
            <li key={i}>
              <span className="font-medium">{q.question}</span>
              <span className="block text-xs text-gray-500">{q.why}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <article className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{envelope.title}</h1>
        {envelope.subtitle && (
          <p className="text-gray-600">{envelope.subtitle}</p>
        )}
      </header>

      {envelope.blocks.map((b, i) => (
        <BlockView key={i} block={b} sources={envelope.sources} />
      ))}

      {envelope.validation.length > 0 && (
        <section className="flex flex-wrap gap-2">
          {envelope.validation.map((c, i) => (
            <span
              key={i}
              className={`rounded px-2 py-1 text-xs ${TIER_STYLE[c.tier]}`}
            >
              {c.tier.toUpperCase()} {"-"} {c.text}
            </span>
          ))}
        </section>
      )}

      {}
      {!envelope.blocks.some((b) => b.type === "source_list") && (
        <SourceList sources={envelope.sources} />
      )}

      {envelope.failed_lenses.length > 0 && (
        <p className="text-xs text-amber-700">
          Partial coverage {"-"} lenses with issues:{" "}
          {envelope.failed_lenses.join(", ")}
        </p>
      )}
    </article>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold uppercase tracking-wide text-gray-500">
        Sources
      </h2>
      <ol className="space-y-1 text-base">
        {sources.map((s) => (
          <li key={s.n}>
            [{s.n}]{" "}
            <a
              className="text-blue-600 underline"
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {s.title}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

function arrField<T>(block: Block, key: string): T[] {
  const v = (block as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

function Cites({ ns }: { ns?: unknown }) {
  const arr = Array.isArray(ns) ? ns.filter((n): n is number => typeof n === "number") : [];
  if (!arr.length) return null;
  return <sup className="ml-0.5 text-[11px] font-medium text-gray-400">[{arr.join(", ")}]</sup>;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
      {children}
    </h2>
  );
}

type LeakedParse = { prose: string; blocks: Block[] };

function leakedToBlock(parsed: unknown): Block | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const clean = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter(
          (e): e is Record<string, unknown> =>
            !!e && typeof e === "object" && !Array.isArray(e),
        )
      : [];
  const block = (type: string, key: string, arr: Record<string, unknown>[]): Block | null =>
    arr.length ? ({ type, [key]: arr } as Block) : null;

  if (Array.isArray(o.stat_tiles)) return block("stat_tiles", "tiles", clean(o.stat_tiles));
  if (Array.isArray(o.tiles)) return block("stat_tiles", "tiles", clean(o.tiles));
  if (Array.isArray(o.cards)) return block("cards_grid", "cards", clean(o.cards));
  if (Array.isArray(o.items)) return block("cards_grid", "cards", clean(o.items));
  if (Array.isArray(o.risks)) return block("risks", "items", clean(o.risks));
  if (Array.isArray(o.recommendations)) return block("recommendations", "items", clean(o.recommendations));
  if (Array.isArray(o.gap_list)) return block("gap_list", "items", clean(o.gap_list));
  if (Array.isArray(o.gaps)) return block("gap_list", "items", clean(o.gaps));
  return null;
}

export function rehydrateLeakedMarkdown(bodyMd: string): LeakedParse {
  const blocks: Block[] = [];
  const fenceRe = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const prose = bodyMd
    .replace(fenceRe, (full: string, tag: string, inner: string) => {
      const body = inner.trim();
      const isJson = tag.toLowerCase() === "json" || /^[{[]/.test(body);
      if (!isJson) return full;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return "";
      }
      const blk = leakedToBlock(parsed);
      if (blk) blocks.push(blk);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { prose, blocks };
}

function BlockView({ block, sources }: { block: Block; sources: Source[] }) {
  switch (block.type) {
    case "hero":
      return null;

    case "exec_summary": {
      const b = block as { prose_md?: string };
      return (
        <section>
          <Markdown source={String(b.prose_md ?? "")} />
        </section>
      );
    }

    case "markdown": {
      const b = block as { body_md?: string };
      const { prose, blocks: leaked } = rehydrateLeakedMarkdown(String(b.body_md ?? ""));
      const hasProse = prose.length > 0 && prose !== "{}";
      if (!hasProse && leaked.length === 0) return null;
      return (
        <section className="space-y-4">
          {hasProse ? <Markdown source={prose} /> : null}
          {leaked.map((lb, i) => (
            <BlockView key={i} block={lb} sources={sources} />
          ))}
        </section>
      );
    }

    case "source_list": {
      const b = block as { sources?: Source[] };
      return <SourceList sources={b.sources ?? sources} />;
    }

    case "table": {
      const b = block as {
        title?: string;
        columns?: string[];
        rows?: string[][];
      };
      const columns = Array.isArray(b.columns) ? b.columns : [];
      const rows = Array.isArray(b.rows) ? b.rows : [];
      return (
        <section className="overflow-x-auto">
          {b.title && (
            <h3 className="mb-2 text-base font-semibold">{b.title}</h3>
          )}
          <table className="min-w-full border-collapse text-base">
            <thead>
              <tr>
                {columns.map((col, ci) => (
                  <th
                    key={ci}
                    className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-medium text-gray-700"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? "" : "bg-gray-50"}>
                  {(Array.isArray(row) ? row : []).map((cell, ci) => (
                    <td
                      key={ci}
                      className="border border-gray-200 px-3 py-2 text-gray-700"
                    >
                      <Markdown source={String(cell)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    }

    case "validation":
      return null;

    case "stat_tiles": {
      const tiles = arrField<{ value?: string; label?: string; sub?: string; citation?: number; citations?: number[] }>(block, "tiles");
      return (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tiles.map((t, i) => {
            const ns = Array.isArray(t.citations) ? t.citations : t.citation != null ? [t.citation] : [];
            return (
              <div key={i} className="rounded-lg border border-gray-200 p-3">
                <div className="text-xl font-semibold text-gray-900">{String(t.value ?? "")}</div>
                <div className="mt-1 text-xs uppercase tracking-wide text-gray-500">
                  {String(t.label ?? "")}
                  <Cites ns={ns} />
                </div>
                {t.sub ? <div className="mt-1 text-xs text-gray-500">{String(t.sub)}</div> : null}
              </div>
            );
          })}
        </section>
      );
    }

    case "persona_cards": {
      const cards = arrField<Record<string, unknown>>(block, "cards");
      return (
        <section className="grid gap-4 sm:grid-cols-2">
          {cards.map((c, i) => {
            const f = (c.fields ?? {}) as Record<string, string>;
            const bl = typeof c.buy_likelihood === "number" ? c.buy_likelihood : 0;
            const rows: [string, string | undefined][] = [
              ["Primary need", f.primary_need],
              ["Pain point", f.pain_point],
              ["Behavior", f.behavior],
              ["Valued feature", f.valued_feature],
              ["Source of awareness", f.source_of_awareness],
            ];
            return (
              <div key={i} className="rounded-lg border border-gray-200 p-4">
                <div className="text-xs text-gray-400">{String(c.index ?? i + 1).padStart(2, "0")}</div>
                <div className="text-base font-semibold text-gray-900">{String(c.name ?? "")}</div>
                {c.tagline ? (
                  <div className="mb-3 text-xs uppercase tracking-wide text-amber-700">{String(c.tagline)}</div>
                ) : null}
                <dl className="space-y-1.5 text-base">
                  {rows
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="w-28 shrink-0 text-xs uppercase tracking-wide text-gray-400">{k}</dt>
                        <dd className="text-gray-700">{String(v)}</dd>
                      </div>
                    ))}
                </dl>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-gray-400">Buy likelihood</span>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span
                      key={n}
                      className={`inline-block h-2 w-2 rounded-full ${n <= bl ? "bg-amber-500" : "bg-gray-200"}`}
                    />
                  ))}
                </div>
                {c.commentary_md ? (
                  <div className="mt-2 text-base text-gray-600">
                    <Markdown source={String(c.commentary_md)} />
                  </div>
                ) : null}
                <Cites ns={c.citations} />
              </div>
            );
          })}
        </section>
      );
    }

    case "qa_grid": {
      const items = arrField<{ question?: string; answer_md?: string; citations?: number[] }>(block, "items");
      return (
        <section className="grid gap-4 sm:grid-cols-2">
          {items.map((it, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-4">
              <div className="mb-1 text-base font-medium italic text-gray-800">{String(it.question ?? "")}</div>
              <div className="text-base text-gray-700">
                <Markdown source={String(it.answer_md ?? "")} />
              </div>
              <Cites ns={it.citations} />
            </div>
          ))}
        </section>
      );
    }

    case "theme_bars": {
      const b = block as { title?: string; bars?: { label?: string; pct?: number; quote?: string; citations?: number[] }[] };
      const bars = Array.isArray(b.bars) ? b.bars : [];
      return (
        <section>
          {b.title ? <SectionHeading>{b.title}</SectionHeading> : null}
          <div className="space-y-3">
            {bars.map((bar, i) => {
              const pct = Math.max(0, Math.min(100, typeof bar.pct === "number" ? bar.pct : 0));
              return (
                <div key={i}>
                  <div className="flex items-center justify-between text-base">
                    <span className="font-medium text-gray-800">
                      {String(bar.label ?? "")}
                      <Cites ns={bar.citations} />
                    </span>
                    <span className="tabular-nums text-gray-500">{pct}%</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-gray-100">
                    <div className="h-1.5 rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
                  </div>
                  {bar.quote ? <p className="mt-1 text-xs italic text-gray-500">&ldquo;{String(bar.quote)}&rdquo;</p> : null}
                </div>
              );
            })}
          </div>
        </section>
      );
    }

    case "sentiment_meter": {
      const s = ((block as { sentiment?: { pos?: number; neu?: number; neg?: number } }).sentiment ?? {});
      const pos = Number(s.pos) || 0;
      const neu = Number(s.neu) || 0;
      const neg = Number(s.neg) || 0;
      return (
        <section>
          <SectionHeading>Sentiment</SectionHeading>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-100">
            <div className="bg-green-500" style={{ width: `${pos}%` }} />
            <div className="bg-gray-300" style={{ width: `${neu}%` }} />
            <div className="bg-red-400" style={{ width: `${neg}%` }} />
          </div>
          <div className="mt-1 flex gap-4 text-xs text-gray-500">
            <span>{pos}% positive</span>
            <span>{neu}% neutral</span>
            <span>{neg}% negative</span>
          </div>
        </section>
      );
    }

    case "cards_grid": {
      const cards = arrField<{ title?: string; body_md?: string; meta?: { label?: string; value?: string }; citations?: number[] }>(block, "cards");
      return (
        <section className="grid gap-4 sm:grid-cols-2">
          {cards.map((c, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-4">
              <div className="text-base font-semibold text-gray-900">{String(c.title ?? "")}</div>
              <div className="mt-1 text-base text-gray-700">
                <Markdown source={String(c.body_md ?? "")} />
              </div>
              {c.meta && (c.meta.label || c.meta.value) ? (
                <div className="mt-2 text-xs uppercase tracking-wide text-gray-500">
                  {String(c.meta.label ?? "")}
                  {c.meta.label && c.meta.value ? " · " : ""}
                  {String(c.meta.value ?? "")}
                </div>
              ) : null}
              <Cites ns={c.citations} />
            </div>
          ))}
        </section>
      );
    }

    case "competitive_table": {
      const rows = arrField<{ brand?: string; price?: string; positioning?: string; gap?: string; citations?: number[] }>(block, "rows");
      return (
        <section className="overflow-x-auto">
          <table className="min-w-full border-collapse text-base">
            <thead>
              <tr>
                {["Brand", "Price", "Positioning", "Gap"].map((h) => (
                  <th key={h} className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-medium text-gray-700">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className={ri % 2 ? "bg-gray-50" : ""}>
                  <td className="border border-gray-200 px-3 py-2 font-medium text-gray-900">{String(r.brand ?? "")}</td>
                  <td className="border border-gray-200 px-3 py-2 text-gray-700">{String(r.price ?? "-")}</td>
                  <td className="border border-gray-200 px-3 py-2 text-gray-700">{String(r.positioning ?? "")}</td>
                  <td className="border border-gray-200 px-3 py-2 text-gray-700">
                    {String(r.gap ?? "")}
                    <Cites ns={r.citations} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    }

    case "gap_list": {
      const items = arrField<{ category?: string; title?: string; body_md?: string; citations?: number[] }>(block, "items");
      return (
        <section className="space-y-4">
          {items.map((it, i) => (
            <div key={i} className="border-l-2 border-amber-300 pl-3">
              {it.category ? <div className="text-xs uppercase tracking-wide text-gray-400">{String(it.category)}</div> : null}
              <div className="text-base font-semibold text-gray-900">{String(it.title ?? "")}</div>
              <div className="mt-1 text-base text-gray-700">
                <Markdown source={String(it.body_md ?? "")} />
              </div>
              <Cites ns={it.citations} />
            </div>
          ))}
        </section>
      );
    }

    case "recommendations": {
      const items = arrField<{ index?: number; label?: string; title?: string; body_md?: string; citations?: number[] }>(block, "items");
      return (
        <section className="space-y-3">
          <SectionHeading>What to do next</SectionHeading>
          {items.map((it, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-4">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-gray-400">{String(it.label ?? String(it.index ?? i + 1))}</span>
                <span className="text-base font-semibold text-gray-900">{String(it.title ?? "")}</span>
              </div>
              <div className="mt-1 text-base text-gray-700">
                <Markdown source={String(it.body_md ?? "")} />
              </div>
              <Cites ns={it.citations} />
            </div>
          ))}
        </section>
      );
    }

    case "risks": {
      const items = arrField<{ tone?: string; title?: string; body_md?: string; citations?: number[] }>(block, "items");
      return (
        <section className="space-y-3">
          <SectionHeading>Risks &amp; caveats</SectionHeading>
          {items.map((it, i) => {
            const warn = it.tone === "warn";
            return (
              <div key={i} className={`rounded-lg border p-3 ${warn ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50"}`}>
                <div className={`text-base font-semibold ${warn ? "text-red-800" : "text-gray-800"}`}>{String(it.title ?? "")}</div>
                <div className="mt-1 text-base text-gray-700">
                  <Markdown source={String(it.body_md ?? "")} />
                </div>
                <Cites ns={it.citations} />
              </div>
            );
          })}
        </section>
      );
    }

    default:
      return (
        <section>
          <Markdown
            source={"```json\n" + JSON.stringify(block, null, 2) + "\n```"}
          />
        </section>
      );
  }
}

export default ResearchEnvelopeRenderer;
