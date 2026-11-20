"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, Send, Users } from "lucide-react";
import {
  creatorApi,
  CreatorApiError,
  money,
  type CreatorBriefBoard,
  type CreatorBriefCard,
  type CreatorMe,
  type CreatorQuoteFees,
  type MyBriefApplication,
} from "@/lib/creator/api";
import { ErrorNote, SIGNUP_CHECKLIST, useCreatorMe } from "./CreatorChrome";
import { Bone, CardSkeleton } from "./areaUi";
import { NextChevron } from "@/components/ui/NextChevron";

const RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
const FIELD =
  "w-full rounded-xl border border-black/[0.08] bg-white text-[14px] text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-[border-color,box-shadow] duration-200 placeholder:text-inkMuted focus:border-ink/40 focus:shadow-[0_0_0_4px_rgba(9,9,11,0.12)] focus:outline-none";
const BTN_SECONDARY = `${RING} inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-full border border-black/[0.08] bg-white px-6 text-[14px] font-semibold text-[#0e0f11] transition-all hover:bg-[#0e0f11]/[0.04] active:scale-[0.98]`;
const BTN_PRIMARY = `${RING} inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[14px] font-semibold text-white transition-[opacity,transform] duration-200 hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`;

function Card({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className="rounded-block border border-black/[0.06] bg-white/85 p-6 shadow-[0_1px_2px_rgba(16,18,20,0.04),0_18px_44px_-24px_rgba(16,18,20,0.22)] backdrop-blur-xl"
    >
      {children}
    </section>
  );
}

function EmptySlot({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-black/[0.14] bg-white/60 px-4 py-6 text-center text-[14px] leading-relaxed text-inkMuted">
      {children}
    </div>
  );
}

type AppState = "waiting" | "hired" | "cancelled" | "notpicked";

function appState(app: Pick<MyBriefApplication, "status" | "hired_order_id" | "hired_order_status">): AppState {
  if (app.status === "approved" && app.hired_order_id) return app.hired_order_status === "cancelled" ? "cancelled" : "hired";
  if (app.status === "rejected") return "notpicked";
  return "waiting";
}

const APP_LABEL: Record<AppState, { label: string; cls: string }> = {
  waiting: { label: "Applied, waiting", cls: "bg-warnBg text-warn" },
  hired: { label: "Hired", cls: "bg-successBg text-success" },
  cancelled: { label: "Hired, then cancelled", cls: "bg-black/[0.05] text-inkMuted" },
  notpicked: { label: "Not picked this time", cls: "bg-black/[0.05] text-inkMuted" },
};

function StatusPill({ app }: { app: MyBriefApplication }) {
  const s = APP_LABEL[appState(app)];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

function usd(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function shortDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function kindOf(b: CreatorBriefCard): string | null {
  if (b.format) return b.format;
  return b.lane === "ugc_video" ? "Video for their ads" : null;
}

function wantOf(b: CreatorBriefCard): string {
  return [b.angle, b.hook].filter((x) => x && x.trim().length > 0).join(" ");
}

function videosOf(b: CreatorBriefCard): number {
  return b.deliverables != null && b.deliverables >= 1 ? Math.floor(b.deliverables) : 1;
}

function videoWord(n: number): string {
  return n === 1 ? "1 video" : `${n} videos`;
}

function budgetLine(b: CreatorBriefCard): string {
  const per = usd(b.budget_usd);
  const videos = videoWord(videosOf(b));
  return per ? `${videos} · ${per} per video` : videos;
}

function answersBy(b: CreatorBriefCard): string {
  const biz = b.business_name || "The business";
  const when = shortDay(b.answer_by);
  return when ? `${biz} answers by ${when}.` : `${biz} has not set a date to answer by.`;
}

function BriefRow({
  brief,
  active,
  status,
  onPick,
}: {
  brief: CreatorBriefCard;
  active: boolean;
  status: MyBriefApplication | null;
  onPick: () => void;
}) {
  const kind = kindOf(brief);
  const when = shortDay(brief.answer_by);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`${RING} w-full cursor-pointer rounded-2xl border p-4 text-left transition-all ${
        active
          ? "border-ink bg-white shadow-[0_8px_24px_rgba(16,24,40,0.08)]"
          : "border-black/[0.07] bg-white/80 hover:border-black/20"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-inkMuted">
          {brief.business_name || "A business"}
        </span>
        {status ? <span className="shrink-0"><StatusPill app={status} /></span> : null}
      </span>
      <span className="mt-1 block break-words text-[14px] font-semibold text-ink">{brief.title || "A brief"}</span>
      <span className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-inkMuted">
        {kind ? <span className="rounded-full bg-black/[0.04] px-2 py-0.5 font-medium">{kind}</span> : null}
        <span className="font-semibold text-ink">{budgetLine(brief)}</span>
        {when ? <span>answer by {when}</span> : null}
      </span>
      <span className="mt-2 flex items-center gap-2 text-[12px] text-inkMuted">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {brief.applicant_count === 1
          ? "1 creator applied"
          : `${brief.applicant_count} creators applied`}
      </span>
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-inkMuted">{label}</dt>
      <dd className="mt-0.5 break-words text-[14px] font-semibold text-ink">{value}</dd>
    </div>
  );
}

function BriefDetail({ brief }: { brief: CreatorBriefCard }) {
  const kind = kindOf(brief);
  const when = shortDay(brief.answer_by);
  const want = wantOf(brief);
  return (
    <Card label="The brief">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-inkMuted">
        {brief.business_name || "A business"}
      </p>
      <h2 className="mt-1.5 break-words text-[20px] font-bold tracking-tight text-ink">
        {brief.title || "A brief"}
      </h2>
      {want ? <p className="mt-3 break-words text-[14px] leading-relaxed text-inkMuted">{want}</p> : null}
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-black/[0.06] pt-4 text-[14px] sm:grid-cols-4">
        {kind ? <Fact label={brief.format ? "Format" : "Type"} value={kind} /> : null}
        <Fact label={usd(brief.budget_usd) ? "Budget" : "Videos"} value={budgetLine(brief)} />
        {brief.delivery_days != null ? (
          <Fact label="Deliver in" value={`${brief.delivery_days} days`} />
        ) : null}
        {when ? <Fact label="Answer by" value={when} /> : null}
      </dl>
      <p className="mt-4 text-[13px] text-inkMuted">
        If you are hired: 2 rounds of changes, and the business is charged at hire.
      </p>
    </Card>
  );
}

function cleanPrice(raw: string): string {
  const s = raw.replace(/[^0-9.]/g, "");
  const i = s.indexOf(".");
  return i === -1 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, "");
}

function startingPrice(budget: number | null, videos: number): string {
  if (budget === null || !(budget > 0)) return "";
  return String(Math.round((budget * videos * 9) / 10));
}

function ApplyPanel({
  brief,
  onApplied,
}: {
  brief: CreatorBriefCard;
  onApplied: (a: MyBriefApplication) => void;
}) {
  const videos = videosOf(brief);
  const [price, setPrice] = useState(startingPrice(brief.budget_usd, videos));
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<{ price: string; fees: CreatorQuoteFees } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!(Number(price) > 0)) return;
    let live = true;
    const t = setTimeout(() => {
      creatorApi
        .briefQuote(brief.id, price)
        .then((r) => {
          if (live) setQuote({ price, fees: r.fees });
        })
        .catch((e: unknown) => {
          if (live)
            setQuoteError(
              e instanceof CreatorApiError ? e.message : "We couldn't calculate your payout. Try again.",
            );
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [brief.id, price]);

  const n = Number(price);
  const fees = quote && quote.price === price ? quote.fees : null;
  const canApply = n > 0 && !!fees && note.trim().length > 0 && !busy;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await creatorApi.applyToBrief(brief.id, price, note.trim());
      onApplied({
        application_id: r.application_id,
        status: "applied",
        note: note.trim(),
        quoted_rate_usd: null,
        fees: r.fees,
        applied_at: new Date().toISOString(),
      });
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That did not send. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card label="Apply">
      <h3 className="text-[16px] font-semibold text-ink">Apply</h3>
      <label className="mt-4 block max-w-[220px]">
        <span className="mb-2 block text-[14px] font-medium text-ink">
          {videos === 1 ? "Your price for the video" : `Your price for all ${videos} videos`}
        </span>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[14px] text-inkMuted">$</span>
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(cleanPrice(e.target.value))}
            className={`${FIELD} h-12 pl-8 pr-4`}
          />
        </div>
      </label>
      <p className="mt-2 text-[13px] text-inkMuted" data-testid="receive-line">
        {fees ? (
          <>
            You receive{" "}
            <span className="font-semibold text-ink">{money(fees.creator_payout_cents)}</span>{" "}
            after Zavi&apos;s 15%.
          </>
        ) : quoteError ? (
          <span className="text-danger">{quoteError}</span>
        ) : n > 0 ? (
          "Working out what you receive after Zavi's 15%."
        ) : (
          "Enter your price to see what you receive after Zavi's 15%."
        )}
      </p>
      {usd(brief.budget_usd) ? (
        <p className="mt-1 text-[13px] text-inkMuted">
          {videos === 1
            ? `Filled in a little under the ${usd(brief.budget_usd)} budget to start. Set any price you want.`
            : `One price for all ${videos} videos. Filled in a little under the ${usd((brief.budget_usd ?? 0) * videos)} budget (${usd(brief.budget_usd)} per video) to start. Set any price you want.`}
        </p>
      ) : null}
      <label className="mt-4 block">
        <span className="mb-2 block text-[14px] font-medium text-ink">
          Short note to {brief.business_name || "the business"}
        </span>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why you fit, and how you would film it."
          className={`${FIELD} resize-none px-4 py-3 leading-relaxed`}
        />
      </label>
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <button type="button" disabled={!canApply} onClick={apply} className={`${BTN_PRIMARY} mt-4`}>
        <Send className="h-4 w-4" aria-hidden="true" />
        {busy ? "Sending" : "Apply"}
      </button>
      <p className="mt-3 text-[13px] text-inkMuted">One application per brief. {answersBy(brief)}</p>
    </Card>
  );
}

function AppliedCard({ brief, app }: { brief: CreatorBriefCard; app: MyBriefApplication }) {
  const state = appState(app);
  const biz = brief.business_name || "The business";
  return (
    <Card label="Your application">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusPill app={app} />
        {app.fees ? (
          <span className="text-[13px] text-inkMuted">
            Your price {money(app.fees.price_cents)} · you receive{" "}
            {money(app.fees.creator_payout_cents)}
          </span>
        ) : null}
      </div>
      {app.note ? (
        <p className="mt-3 text-[14px] text-inkMuted">Your note: &ldquo;{app.note}&rdquo;</p>
      ) : null}
      {state === "waiting" ? (
        <p className="mt-3 text-[14px] leading-relaxed text-ink">
          {answersBy(brief)} We email you either way.
        </p>
      ) : null}
      {state === "hired" || state === "cancelled" ? (
        <>
          <p className="mt-3 text-[14px] leading-relaxed text-ink">
            {app.hired_order_status === "completed"
              ? `${biz} hired you and paid. The job is finished.`
              : app.hired_order_status === "cancelled"
                ? `${biz} hired you, then the job was cancelled and the charge was refunded.`
                : `${biz} hired you and paid. The job is in progress.`}
          </p>
          <Link
            href={app.hired_order_id ? `/creator/jobs/${encodeURIComponent(app.hired_order_id)}` : "/creator/jobs"}
            className={`${BTN_PRIMARY} mt-4`}
          >
            Open job
            <NextChevron />
          </Link>
        </>
      ) : null}
      {state === "notpicked" ? (
        <div className="mt-3 rounded-xl bg-black/[0.03] px-4 py-3">
          {app.business_note ? (
            <>
              <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-inkMuted">
                Note from {biz}
              </p>
              <p className="mt-1 text-[14px] text-ink">&ldquo;{app.business_note}&rdquo;</p>
            </>
          ) : null}
          <p className="mt-2 text-[13px] text-inkMuted">
            Your application is closed. Nothing was charged and nothing is owed.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function BeforeApply({ me }: { me: CreatorMe }) {
  const missing = SIGNUP_CHECKLIST.filter((c) => !me.setup[c.key]);
  if (missing.length === 0) {
    return (
      <Card label="Before you apply">
        <h3 className="text-[16px] font-semibold text-ink">Before you apply: Zavi is reviewing your profile</h3>
        <p className="mt-2 text-[14px] leading-relaxed text-inkMuted">
          You can apply to briefs once Zavi approves your profile.
        </p>
      </Card>
    );
  }
  return (
    <Card label="Before you apply">
      <h3 className="text-[16px] font-semibold text-ink">
        Before you apply: add {missing.map((c) => c.label.split(",")[0].toLowerCase()).join(", ")}
      </h3>
      <p className="mt-2 text-[14px] leading-relaxed text-inkMuted">
        Businesses can hire you once your profile has all three steps.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {SIGNUP_CHECKLIST.map((c, i) => {
          const done = me.setup[c.key];
          const next = c.id === missing[0].id;
          return (
            <Link key={c.id} href={`/creators/apply?step=${c.id}`} className={next ? BTN_PRIMARY : BTN_SECONDARY}>
              {done ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
              {i + 1}. {c.label.split(",")[0]}
              {!done ? <NextChevron /> : null}
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

export function BriefsBoardSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading open briefs.</span>
      <div aria-hidden="true">
        <Bone className="h-8 w-52 rounded-full" />
        <Bone className="mt-3 h-4 w-full max-w-[560px] rounded-full" />
        <Bone className="mt-2 h-4 w-2/3 max-w-[420px] rounded-full" />
        <div className="mt-6 grid items-start gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-2xl border border-black/[0.07] bg-white p-4">
                <Bone className="h-3 w-24 rounded-full" />
                <Bone className="mt-2.5 h-4 w-3/4 rounded-full" />
                <Bone className="mt-3 h-3 w-1/2 rounded-full" />
              </div>
            ))}
          </div>
          <div className="rounded-block border border-black/[0.06] bg-white p-6">
            <Bone className="h-3 w-24 rounded-full" />
            <Bone className="mt-3 h-6 w-2/3 rounded-full" />
            <Bone className="mt-4 h-4 w-full rounded-full" />
            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-black/[0.06] pt-4 sm:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Bone key={i} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CreatorBriefsBoard() {
  const { me } = useCreatorMe();
  const params = useSearchParams();
  const wanted = params?.get("brief") ?? null;
  const [data, setData] = useState<CreatorBriefBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<string, MyBriefApplication | null | "error">>({});

  useEffect(() => {
    creatorApi
      .briefs()
      .then((b) => {
        setData(b);
        const all = [...b.briefs, ...(b.applied_closed ?? [])];
        setSelectedId(wanted ? (all.find((x) => x.id === wanted)?.id ?? null) : (all[0]?.id ?? null));
      })
      .catch((e: unknown) =>
        setError(e instanceof CreatorApiError ? e.message : "The board did not load."),
      );
  }, [wanted]);

  const approved = me.vetting_state === "approved";
  useEffect(() => {
    if (!data || !approved) return;
    let live = true;
    for (const b of [...data.briefs, ...(data.applied_closed ?? [])]) {
      creatorApi
        .openBrief(b.id)
        .then((d) => {
          if (live) setMine((m) => ({ ...m, [b.id]: d.my_application }));
        })
        .catch(() => {
          if (live) setMine((m) => ({ ...m, [b.id]: "error" }));
        });
    }
    return () => {
      live = false;
    };
  }, [data, approved]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <BriefsBoardSkeleton />;

  const closedIds = new Set((data.applied_closed ?? []).map((b) => b.id));
  const rows = [...data.briefs, ...(data.applied_closed ?? []).filter((b) => !data.briefs.some((o) => o.id === b.id))];
  const selected = rows.find((b) => b.id === selectedId) ?? null;
  const app = selected ? mine[selected.id] : undefined;
  const ownApp = (id: string): MyBriefApplication | null => {
    const v = mine[id];
    return v && v !== "error" ? v : null;
  };
  const allApplied = rows.length > 0 && rows.every((b) => !!ownApp(b.id));
  const wantedMissing = !!wanted && !rows.some((b) => b.id === wanted);

  return (
    <div>
      <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">
        {allApplied ? "Your applications" : "Briefs for you"}
      </h1>
      <p className="mt-2 max-w-[620px] text-[14px] leading-relaxed text-inkMuted">
        Businesses write these. Set your own price, add a short note, and the business picks who they
        hire. One application per brief.
      </p>
      {}
      <p className="mt-1.5 max-w-[620px] text-[14px] leading-relaxed text-inkMuted">
        Already booked or hired? What the business asked for is on the job, in{" "}
        <Link href="/creator/jobs" className="font-semibold text-ink underline underline-offset-2">
          Jobs
        </Link>
        .
      </p>
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="space-y-3">
          {rows.length === 0 ? (
            <EmptySlot>
              No briefs for you right now. Briefs that fit your platforms and niches show here and in
              your Inbox.
            </EmptySlot>
          ) : null}
          {rows.map((b) => (
            <BriefRow
              key={b.id}
              brief={b}
              active={b.id === selected?.id}
              status={ownApp(b.id)}
              onPick={() => setSelectedId(b.id)}
            />
          ))}
          {rows.length > 0 ? (
            <p className="px-1 text-[12px] text-inkMuted">
              {data.order}
            </p>
          ) : null}
        </div>

        <div className="space-y-4">
          {!selected && wantedMissing ? (
            <EmptySlot>That brief is not open any more. Pick another brief from the list.</EmptySlot>
          ) : !selected ? (
            <>
              <EmptySlot>Pick a brief to see what the business wants, the budget and the deadline.</EmptySlot>
              <EmptySlot>Your price and a short note go here when you apply.</EmptySlot>
            </>
          ) : (
            <>
              <BriefDetail brief={selected} />
              {!approved ? (
                <BeforeApply me={me} />
              ) : app === undefined ? (
                <CardSkeleton label="Loading your application." />
              ) : app === "error" ? (
                <ErrorNote message="We couldn't check your application for this brief. Reload to try again." />
              ) : app ? (
                <AppliedCard brief={selected} app={app} />
              ) : closedIds.has(selected.id) ? (
                <EmptySlot>This brief is closed.</EmptySlot>
              ) : (
                <ApplyPanel
                  key={selected.id}
                  brief={selected}
                  onApplied={(a) => setMine((m) => ({ ...m, [selected.id]: a }))}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
