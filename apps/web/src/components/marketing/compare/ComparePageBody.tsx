
import Link from "next/link";
import {
  formatSeen,
  type Claim,
  type Comparison,
} from "@/lib/marketing/comparisons";

function SourceLink({ claim }: { claim: Claim }) {
  return (
    <a
      href={claim.sourceUrl}
      rel="nofollow noopener noreferrer"
      target="_blank"
      className="ml-1 whitespace-nowrap text-[13px] text-[#595959] underline underline-offset-2 hover:text-[#0e0f11]"
    >
      source
    </a>
  );
}

export function ComparePageBody({
  c,
  startHref,
}: {
  c: Comparison;
  startHref: string;
}) {
  const seen = [...new Set([...c.rows.map((r) => r.other.seen), ...c.otherWins.map((w) => w.seen)])].sort();
  const sources = [...new Set([...c.rows.map((r) => r.other.sourceUrl), ...c.otherWins.map((w) => w.sourceUrl)])];

  return (
    <article className="mx-auto w-full max-w-[860px] px-4 pb-16 pt-6 md:pb-24 md:pt-10">
      <p className="text-[13px] uppercase tracking-[2px] text-[#191919]">Compare</p>
      <h1 className="pt-2 text-[32px] font-semibold leading-[1.1] tracking-[-0.83px] text-[#191919] md:text-[44px]">
        {c.h1}
      </h1>
      <p className="pt-4 text-[18px] leading-[28px] text-[#595959]">{c.intro}</p>

      <section aria-labelledby="verdict" className="mt-8 rounded-2xl border border-[#e6e6e6] p-5 md:p-6">
        <h2 id="verdict" className="text-[18px] font-semibold text-[#0e0f11]">
          The short answer
        </h2>
        <p className="pt-2 text-[16px] leading-[26px] text-[#0e0f11]">{c.pickOther}</p>
        <p className="pt-2 text-[16px] leading-[26px] text-[#0e0f11]">{c.pickZavi}</p>
      </section>

      <section aria-labelledby="side-by-side" className="pt-10">
        <h2 id="side-by-side" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
          Side by side
        </h2>
        {}
        <dl className="mt-4 space-y-4 md:hidden">
          {c.rows.map((r) => (
            <div key={r.label} className="rounded-xl border border-[#ececec] p-4 text-[15px] leading-[24px]">
              <dt className="font-semibold text-[#0e0f11]">{r.label}</dt>
              <dd className="pt-2 text-[#0e0f11]">
                <span className="font-medium">{c.other}: </span>
                {r.other.text}
                <SourceLink claim={r.other} />
              </dd>
              <dd className="pt-2 text-[#0e0f11]">
                <span className="font-medium">Zavi: </span>
                {r.zavi}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 hidden md:block">
          <table className="w-full border-collapse text-left text-[15px] leading-[24px]">
            <thead>
              <tr className="border-b border-[#e6e6e6] text-[13px] uppercase tracking-[1px] text-[#595959]">
                <th scope="col" className="w-[22%] py-3 pr-4 font-medium" />
                <th scope="col" className="py-3 pr-4 font-medium">
                  {c.other}
                </th>
                <th scope="col" className="py-3 font-medium">
                  Zavi
                </th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.label} className="border-b border-[#f0f0f0] align-top">
                  <th scope="row" className="py-3 pr-4 font-semibold text-[#0e0f11]">
                    {r.label}
                  </th>
                  <td className="py-3 pr-4 text-[#0e0f11]">
                    {r.other.text}
                    <SourceLink claim={r.other} />
                  </td>
                  <td className="py-3 text-[#0e0f11]">{r.zavi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="other-wins" className="pt-10">
        <h2 id="other-wins" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
          Where {c.other} is the better pick
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[16px] leading-[26px] text-[#0e0f11]">
          {c.otherWins.map((w) => (
            <li key={w.text}>
              {w.text}
              <SourceLink claim={w} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="zavi-wins" className="pt-10">
        <h2 id="zavi-wins" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
          Where Zavi is the better pick
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[16px] leading-[26px] text-[#0e0f11]">
          {c.zaviWins.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="faq" className="pt-10">
        <h2 id="faq" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
          Questions
        </h2>
        <dl className="mt-3 space-y-5">
          {c.faq.map((f) => (
            <div key={f.q}>
              <dt className="text-[16px] font-semibold text-[#0e0f11]">{f.q}</dt>
              <dd className="pt-1 text-[16px] leading-[26px] text-[#0e0f11]">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="pt-10 text-[13px] leading-[20px] text-[#595959]">
        Facts about {c.other} checked on {seen.map(formatSeen).join(", ")} from {c.other}&apos;s own pages
        ({sources.length} {sources.length === 1 ? "source" : "sources"}, linked above). Products change; follow the
        links for their current details.
      </p>

      <nav aria-label="Next steps" className="flex flex-wrap gap-x-6 gap-y-3 pt-8 text-[16px] font-semibold">
        <Link href={startHref} prefetch={false} className="underline underline-offset-4 hover:opacity-70">
          Start free
        </Link>
        <Link href="/about" className="underline underline-offset-4 hover:opacity-70">
          What an AI growth agent is
        </Link>
        <Link href="/pricing" className="underline underline-offset-4 hover:opacity-70">
          See pricing
        </Link>
      </nav>
    </article>
  );
}
