
export function ScoreBar({ total, outOf, delay = 0 }: { total: number; outOf: number; delay?: number }) {
  const pct = outOf > 0 ? Math.round((total / outOf) * 100) : 0;
  return (
    <span className="flex items-center gap-3">
      <span className="block h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-black/[0.06]">
        <span
          className="block h-full origin-left rounded-full bg-[linear-gradient(90deg,#0e0f11,#027bff)] [animation:lbFill_900ms_cubic-bezier(.2,.8,.2,1)_both]"
          style={{ width: `${pct}%`, animationDelay: `${delay}ms` }}
        />
      </span>
      <span className="text-[14px] font-semibold tabular-nums">
        {total}
        <span className="text-[13px] font-normal text-[#595959]">/{outOf}</span>
      </span>
    </span>
  );
}

export function NewPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#e6f2ff] px-2 py-0.5 text-[11px] font-semibold tracking-wide text-[#027bff]">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#027bff]" /> New
    </span>
  );
}

export function Placeholder({ className }: { className: string }) {
  return (
    <span
      className={`inline-block rounded-full bg-[linear-gradient(90deg,rgba(0,0,0,0.04),rgba(0,0,0,0.08),rgba(0,0,0,0.04))] bg-[length:200%_100%] align-middle [animation:lbSheen_2.4s_linear_infinite] ${className}`}
    />
  );
}

export function EmptyRow({ rank }: { rank: number }) {
  return (
    <tr data-testid="empty-row" className="border-t border-black/[0.05] first:border-t-0">
      <td className="py-4 pl-6 pr-3 text-[#595959] tabular-nums">{rank}</td>
      <td className="py-4 pr-6" colSpan={5}>
        <Placeholder className="h-3 w-44" />
        <span className="ml-3 text-[13px] text-[#595959]">Open spot</span>
      </td>
    </tr>
  );
}
