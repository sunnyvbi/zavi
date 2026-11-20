
export function HeroProductPreview() {
  return (
    <div className="relative mt-12 md:mt-14">
      {}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-6 -inset-y-8 md:-inset-x-12 md:-inset-y-14 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 50%, rgba(25,25,25,0.28) 0%, rgba(25,25,25,0) 70%)",
        }}
      />
      <div className="relative mx-auto max-w-[920px] rounded-2xl border border-cream/15 bg-[#0E2748]/85 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)] backdrop-blur-sm overflow-hidden">
        {}
        <div className="flex items-center gap-2.5 border-b border-cream/10 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-cream/25" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-cream/20" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-cream/15" aria-hidden />
          <span className="ml-3 font-mono text-[12px] tracking-wide text-cream/40">
            zavi · workspace · chief-of-staff
          </span>
        </div>

        {}
        <div className="grid grid-cols-12 min-h-[320px]">
          {}
          <aside className="col-span-3 hidden md:flex flex-col gap-1 border-r border-cream/10 px-3 py-4 text-[12px]">
            <div className="px-2 pb-2 text-[11px] font-mono uppercase tracking-[0.16em] text-cream/40">
              Agents
            </div>
            <SidebarRow active label="chief-of-staff" running />
            <SidebarRow label="pm" success />
            <SidebarRow label="engineer" running />
            <SidebarRow label="qa" success />
            <SidebarRow label="performance-marketer" success />
            <SidebarRow label="dispute-response" success />
          </aside>

          {}
          <main className="col-span-12 md:col-span-9 flex flex-col px-4 py-4 md:px-7 md:py-6 gap-3">
            {}
            <div className="self-end max-w-[78%] rounded-2xl bg-cream text-ink px-4 py-2.5 text-[16px] leading-[1.5]">
              What broke yesterday and who&apos;s on it?
            </div>

            {}
            <div className="self-start max-w-[88%] rounded-2xl bg-cream/5 border border-cream/10 px-4 py-3 text-[13px] leading-[1.55] text-cream/90">
              <div className="mb-1.5 flex items-center gap-2 text-[12px] text-cream/60">
                <span
                  aria-hidden
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-cream text-ink font-mono text-[11px] font-semibold"
                >
                  C
                </span>
                <span className="font-mono">chief-of-staff</span>
                <span className="text-cream/30">· 09:14 PT</span>
              </div>
              <p>
                Two fires from the last 24h. PR #1182 from{" "}
                <span className="font-medium text-cream">engineer</span> is
                blocked on you. It fixes the $493 split-rounding overcharge from
                trip 1058. Three Stripe chargebacks landed overnight, and{" "}
                <span className="font-medium text-cream">dispute-response</span>{" "}
                drafted evidence packets for all three. Approval queue: 4 items.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px]">
                <Chip>memory_note:fires-24h</Chip>
                <Chip>agent_run:cof-08a2…</Chip>
                <Chip>decision:approve-pr-1182</Chip>
              </div>
            </div>

            {}
            <div className="mt-auto rounded-xl border border-cream/15 bg-[#0A1F3A] px-3.5 py-3 text-[13px] text-cream/40">
              Message chief-of-staff · ⏎ send · /run · @agent
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function SidebarRow({
  label,
  active,
  running,
  success,
}: {
  label: string;
  active?: boolean;
  running?: boolean;
  success?: boolean;
}) {
  const pip = running
    ? "bg-emerald-400"
    : success
      ? "bg-cream/40"
      : "bg-cream/20";
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[12px] ${
        active
          ? "bg-cream/8 text-cream"
          : "text-cream/65 hover:bg-cream/5"
      }`}
    >
      <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${pip}`} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-cream/15 bg-cream/5 px-2 py-0.5 font-mono text-cream/70">
      {children}
    </span>
  );
}
