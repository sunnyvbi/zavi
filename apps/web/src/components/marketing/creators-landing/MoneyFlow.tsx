import type { CSSProperties } from "react";
import { BadgeCheck, CreditCard, Landmark, Percent, ShieldCheck, Tag, Video, Wallet, type LucideIcon } from "lucide-react";
import { businessTotal, creatorGets, FEES, money, REVISION_ROUNDS } from "./fees";

const PRICE = 150;
const CYCLE = 8;

type Stop = { Icon: LucideIcon; title: string; body: string; tone: string };

const STOPS: Stop[] = [
  { Icon: CreditCard, title: `Business pays ${money(businessTotal(PRICE))}`, body: `Your ${money(PRICE)} price plus ${FEES.businessPct}%.`, tone: "#0e0f11" },
  { Icon: ShieldCheck, title: "Zavi holds it", body: "Held at booking, charged when you accept.", tone: "#9b5de5" },
  { Icon: Video, title: "You deliver", body: `${REVISION_ROUNDS} rounds of changes included.`, tone: "#f06a35" },
  { Icon: BadgeCheck, title: "Business approves", body: "That releases your payout.", tone: "#14a38b" },
  { Icon: Landmark, title: `You receive ${money(creatorGets(PRICE))}`, body: "Via Stripe: US, Canada, UK, EEA, Switzerland.", tone: "#1f9d55" },
];

const FACTS: { Icon: LucideIcon; title: string; body: string }[] = [
  { Icon: Tag, title: "You set your prices", body: "Every package carries the price you choose." },
  { Icon: Wallet, title: "No bank details until your first job", body: "You set up Stripe payouts when you accept a job, not at sign up." },
  { Icon: Percent, title: "One simple fee rule", body: `Zavi takes ${FEES.creatorPct}% from you. The business pays ${FEES.businessPct}% on top.` },
];

const at = (i: number) => (0.8 * i) / (STOPS.length - 1);

function Dot({ s, i }: { s: Stop; i: number }) {
  return (
    <span
      className="relative z-10 flex size-12 shrink-0 items-center justify-center rounded-full border border-black/[0.08] bg-white text-[#0e0f11] shadow-[0_8px_20px_-12px_rgba(16,18,20,0.4)] [animation:mfStop_8s_ease-out_infinite] motion-reduce:[animation:none]"
      style={{ "--tone": s.tone, animationDelay: `${at(i) * CYCLE}s` } as CSSProperties}
    >
      <s.Icon className="size-5" style={{ color: s.tone }} />
    </span>
  );
}

function Coin({ vertical }: { vertical?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute z-20 flex size-5 items-center justify-center rounded-full bg-[#ffd43b] text-[11px] font-extrabold text-[#6b4e00] shadow-[0_0_0_4px_rgba(255,212,59,0.25),0_4px_10px_rgba(0,0,0,0.2)] motion-reduce:hidden ${
        vertical ? "left-[14px] [animation:mfDown_8s_linear_infinite]" : "top-[14px] [animation:mfRight_8s_linear_infinite]"
      }`}
    >
      $
    </span>
  );
}

export function MoneyFlow() {
  return (
    <section data-creator-money className="w-full bg-white py-14 lg:py-16">
      <style>{`
        @keyframes mfRight{0%{left:calc(10% - 10px);opacity:0}4%{opacity:1}80%{left:calc(90% - 10px);opacity:1}90%,100%{left:calc(90% - 10px);opacity:0}}
        @keyframes mfDown{0%{top:14px;opacity:0}4%{opacity:1}80%{top:calc(100% - 34px);opacity:1}90%,100%{top:calc(100% - 34px);opacity:0}}
        @keyframes mfStop{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--tone) 45%,transparent);transform:scale(1.08)}18%{box-shadow:0 0 0 12px transparent;transform:scale(1)}100%{box-shadow:0 0 0 0 transparent;transform:scale(1)}}
      `}</style>
      <div className="mx-auto max-w-[1180px] px-6 lg:px-10">
        <div className="mx-auto max-w-[720px] text-center">
          <h2 className="text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">Where your money goes</h2>
          <p className="mx-auto mt-4 max-w-[54ch] text-[16px] leading-relaxed text-[#595959]">
            On a {money(PRICE)} package, from the business&apos;s card to your bank.
          </p>
        </div>

        {}
        <div className="relative mt-10 hidden md:block">
          <span aria-hidden="true" className="absolute top-6 right-[10%] left-[10%] h-0.5 rounded-full bg-[repeating-linear-gradient(90deg,rgba(16,18,20,0.18)_0_6px,transparent_6px_12px)]" />
          <Coin />
          <ol className="relative grid grid-cols-5">
            {STOPS.map((s, i) => (
              <li key={s.title} className="flex flex-col items-center px-2 text-center">
                <Dot s={s} i={i} />
                <p className="mt-4 text-[16px] leading-snug font-semibold text-[#0e0f11] tabular-nums">{s.title}</p>
                <p className="mt-1.5 max-w-[24ch] text-[14px] leading-relaxed text-[#595959]">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>

        {}
        <div className="relative mx-auto mt-10 max-w-[420px] md:hidden">
          <span aria-hidden="true" className="absolute top-6 bottom-6 left-[23px] w-0.5 rounded-full bg-[repeating-linear-gradient(180deg,rgba(16,18,20,0.18)_0_6px,transparent_6px_12px)]" />
          <Coin vertical />
          <ol className="relative flex flex-col gap-6">
            {STOPS.map((s, i) => (
              <li key={s.title} className="flex items-start gap-4">
                <Dot s={s} i={i} />
                <div className="pt-1">
                  <p className="text-[16px] leading-snug font-semibold text-[#0e0f11] tabular-nums">{s.title}</p>
                  <p className="mt-1 text-[14px] leading-relaxed text-[#595959]">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <ul className="mt-10 grid gap-3 md:grid-cols-3">
          {FACTS.map((f) => (
            <li key={f.title} className="flex items-start gap-3 rounded-[20px] border border-black/[0.08] bg-[#f9f9f9] px-4 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.08] bg-white text-[#0e0f11]">
                <f.Icon className="size-[18px]" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-[16px] font-semibold text-[#0e0f11]">{f.title}</p>
                <p className="mt-1 text-[14px] leading-relaxed text-[#595959]">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
