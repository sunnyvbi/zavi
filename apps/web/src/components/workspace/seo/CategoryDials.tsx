
import { categoryScore100, humanizeId, scoreBand, BAND_WORD } from "./format";
import { BAND_TEXT } from "./ui";
import type { LabCategory } from "./types";

const CATEGORY_LABEL: Record<string, string> = {
  performance: "Speed",
  accessibility: "Accessible",
  "best-practices": "Best practice",
  seo: "On-page SEO",
};

export function isFractionCategory(c: LabCategory): boolean {
  return c.display_mode === "fraction";
}

function categoryLabel(c: LabCategory): string {
  const byId = c.id ? CATEGORY_LABEL[c.id] : undefined;
  return byId ?? c.title ?? humanizeId(c.id) ?? "Score";
}

function Dial({ category }: { category: LabCategory }) {
  const score = categoryScore100(category.score);
  const label = categoryLabel(category);
  const band = score === null ? null : scoreBand(score);
  const fill =
    band === "pass" ? "#167F50" : band === "warn" ? "#946300" : band === "fail" ? "#CB2029" : "#d8d8d8";
  const pct = score ?? 0;
  return (
    <div className="w-[64px] shrink-0 text-center">
      <div
        aria-hidden
        className="mx-auto grid h-[52px] w-[52px] place-items-center rounded-full"
        style={{
          background: `conic-gradient(${fill} 0 ${pct}%, rgb(var(--c-rule)) ${pct}% 100%)`,
        }}
      >
        <span
          className={`grid h-[40px] w-[40px] place-items-center rounded-full bg-white text-[16px] font-semibold tabular-nums ${
            band ? BAND_TEXT[band] : "text-inkMuted"
          }`}
        >
          {score ?? "-"}
        </span>
      </div>
      <p aria-hidden className="mt-1 text-[12px] leading-[1.25] text-inkMuted">
        {label}
      </p>
      {}
      {band ? (
        <p
          aria-hidden
          className={`text-[11px] font-semibold leading-[1.25] ${BAND_TEXT[band]}`}
        >
          {BAND_WORD[band]}
        </p>
      ) : null}
      <span className="sr-only">
        {label}:{" "}
        {score === null
          ? "not scored"
          : `${score} out of 100, ${BAND_WORD[scoreBand(score)]}`}
      </span>
    </div>
  );
}

export function CategoryDials({ categories }: { categories: LabCategory[] }) {
  const shown = categories.filter((c) => !isFractionCategory(c));
  if (shown.length === 0) return null;
  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {shown.map((c, i) => (
          <Dial key={c.id ?? c.title ?? i} category={c} />
        ))}
      </div>
      {}
      <p className="mt-1.5 text-[12px] leading-[1.5] text-inkMuted">
        Google scores each of these out of 100. They grade different things: a
        page can score 100 for best practice and still be slow.
      </p>
    </div>
  );
}
