import type { Cta } from "@/lib/resolveCta";

export function CtaLabel({ cta }: { cta: Cta }) {
  const short = cta.shortLabel ?? cta.label;
  if (short === cta.label) return <>{cta.label}</>;
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{cta.label}</span>
    </>
  );
}
