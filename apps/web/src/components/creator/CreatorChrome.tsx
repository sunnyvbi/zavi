"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Briefcase, Check, ChevronDown, CircleDashed, FileText, Globe, Image as ImageIcon, Inbox, Link2, MessageSquare, Pencil, Plus, UserRound, Video, Wallet, type LucideIcon } from "lucide-react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { UserMenu } from "@/components/UserMenu";
import { creatorApi, CreatorApiError, type CreatorMe, type CreatorSetup } from "@/lib/creator/api";
import { PAYABLE_COUNTRIES, PAYOUT_REGIONS_LINE, canPay, countryName } from "@/lib/creator/packageSpec";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, Bone, Card, CreatorFrame, FIELD, Loading as UiLoading, RING, StatusPill } from "./areaUi";
import { INBOX_CHANGED, changesAsked, messagesWaiting, unreadUpdates } from "./CreatorInbox";
import { CreatorBell, type BellFeed } from "./CreatorBell";
import { JOBS_CHANGED, jobCounts } from "./CreatorJobs";
import { NextChevron } from "@/components/ui/NextChevron";

function creatorTabs(): { href: string; label: string; Icon: LucideIcon }[] {
  return [
    { href: "/creator", label: "Inbox", Icon: Inbox },
    { href: "/creator/messages", label: "Messages", Icon: MessageSquare },
    ...(CREATOR_MARKETPLACE_ENABLED ? [{ href: "/creator/briefs", label: "Briefs", Icon: FileText }] : []),
    { href: "/creator/jobs", label: "Jobs", Icon: Briefcase },
    { href: "/creator/earnings", label: "Earnings", Icon: Wallet },
    ...(CREATOR_MARKETPLACE_ENABLED ? [{ href: "/creator/affiliate", label: "Affiliate", Icon: Link2 }] : []),
    { href: "/creator/profile", label: "Profile", Icon: UserRound },
  ];
}

export const SIGNUP_CHECKLIST = [
  { id: "account", key: "dob", label: "Your age, 18 or older" },
  { id: "make", key: "make", label: "What you make" },
  { id: "package", key: "package", label: "Your first package" },
] as const;

const CLOSED_ACCOUNT_MESSAGE = "Your creator account is closed. Email support if you think that is wrong.";

function isActive(pathname: string, href: string): boolean {
  if (href === "/creator") return pathname === "/creator";
  return pathname === href || pathname.startsWith(`${href}/`);
}

type Ctx = { me: CreatorMe; reload: () => void };
const MeContext = createContext<Ctx | null>(null);

export function useCreatorMe(): Ctx {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useCreatorMe outside CreatorChrome");
  return ctx;
}

export function useOptionalCreatorMe(): Ctx | null {
  return useContext(MeContext);
}

type SetupRow = { id: "goal" | "account" | "make" | "package"; label: string; done: boolean };

export function setupCardFor(setup: CreatorSetup): { title: string; rows: SetupRow[]; extras: boolean; footer: string } {
  const mode = setup.earn_mode ?? null;
  const jobs = mode === "jobs" || mode === "both";
  const rows: SetupRow[] = [
    { id: "goal", label: "How you want to earn", done: !!setup.goal },
    { id: "account", label: "Your age, 18 or older", done: setup.dob },
    { id: "make", label: "What you make", done: setup.make },
  ];
  if (jobs) rows.push({ id: "package", label: "Your first package", done: setup.package });
  const title = mode === "affiliate" ? "Finish setup to get your affiliate link" : mode ? "Finish your profile to get booked" : "Finish setup";
  const footer =
    mode === "affiliate"
      ? "Your affiliate link is ready once these are done. You can look around now."
      : mode === "both"
        ? "Your affiliate link is ready, and businesses can find and book you, once you have a package."
        : mode === "jobs"
          ? "Businesses can find and book you once you have a package. You can look around and apply to briefs now."
          : "Pick how you want to earn and setup only asks for what you picked. You can look around now.";
  return { title, rows, extras: jobs, footer };
}

export function CreatorChrome({
  children,
}: {
  title?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const pathname = usePathname() ?? "/creator";
  const [me, setMe] = useState<CreatorMe | null>(null);
  const [gate, setGate] = useState<{ code: string; message: string } | null>(null);
  const [hasWorkspace, setHasWorkspace] = useState(false);

  const load = useCallback(() => {
    creatorApi
      .me()
      .then(setMe)
      .catch((e: unknown) => {
        if (e instanceof CreatorApiError) setGate({ code: e.code, message: e.message });
        else setGate({ code: "unknown", message: "That did not load. Try again." });
      });
  }, []);

  useEffect(load, [load]);

  const [waiting, setWaiting] = useState<{ inbox: number; messages: number }>({ inbox: 0, messages: 0 });
  const [feed, setFeed] = useState<BellFeed | null>(null);
  const [recount, setRecount] = useState(0);
  const closed = me?.vetting_state === "rejected";
  const closedMayOpen = isActive(pathname, "/creator/jobs") || isActive(pathname, "/creator/earnings");
  const shownGate = gate ?? (closed && !closedMayOpen ? { code: "not_approved", message: CLOSED_ACCOUNT_MESSAGE } : null);
  const ready = !!me && me.setup.complete && !closed;
  useEffect(() => {
    const bump = () => setRecount((n) => n + 1);
    window.addEventListener(INBOX_CHANGED, bump);
    const every = window.setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, 30_000);
    return () => {
      window.removeEventListener(INBOX_CHANGED, bump);
      window.clearInterval(every);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    Promise.all([creatorApi.inbox(), creatorApi.threads(), creatorApi.jobs("active").catch(() => ({ jobs: [] }))])
      .then(([i, t, j]) => {
        if (!live) return;
        setWaiting({
          inbox: i.requests.length + changesAsked(j.jobs).length + unreadUpdates(i.alerts).length,
          messages: messagesWaiting(t.threads),
        });
        setFeed({ requests: i.requests, changes: changesAsked(j.jobs), alerts: i.alerts, threads: t.threads });
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, [ready, pathname, recount]);

  const [pendingJobs, setPendingJobs] = useState(0);
  useEffect(() => {
    const onJobs = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === "number") setPendingJobs(n);
    };
    window.addEventListener(JOBS_CHANGED, onJobs);
    return () => window.removeEventListener(JOBS_CHANGED, onJobs);
  }, []);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    creatorApi
      .jobs("all")
      .then((v) => {
        if (live) setPendingJobs(jobCounts(v.jobs).pending);
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, [ready, pathname, recount]);

  const gated = !!shownGate;
  useEffect(() => {
    if (!gated) return;
    let live = true;
    creatorApi
      .home()
      .then((h) => {
        if (live) setHasWorkspace(h.home === "/workspace");
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, [gated]);

  if (shownGate) {
    return (
      <CreatorFrame>
        <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground sm:text-[30px]">Your creator area</h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{shownGate.message}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {CREATOR_MARKETPLACE_ENABLED && shownGate.code === "not_a_creator" ? (
            <Link href="/creators/apply" className={BTN_PRIMARY}>
              Join as a creator
            </Link>
          ) : null}
          {}
          {hasWorkspace ? (
            <Link href="/workspace" className={BTN_SECONDARY}>
              Go to your workspace
            </Link>
          ) : null}
        </div>
      </CreatorFrame>
    );
  }

  const settingUp = CREATOR_MARKETPLACE_ENABLED && !!me && !closed && !me.setup.complete;
  const country = me?.creator.country_code ?? null;
  const showCountry = !!me && !closed && !settingUp && !canPay(country) &&
    (CREATOR_MARKETPLACE_ENABLED || pathname === "/creator/earnings");

  return (
    <CreatorFrame
      wide
      right={
        me ? (
          <div className="flex items-center gap-2">
            {ready ? <CreatorBell feed={feed} /> : null}
            <UserMenu email={me.creator.display_name} variant="creator" />
          </div>
        ) : (
          <Bone className="h-8 w-32 rounded-full" />
        )
      }
      nav={<CreatorTabs pathname={pathname} waiting={waiting} pendingJobs={pendingJobs} />}
      full={pathname === "/creator/messages"}
      avatar={me ? <RailAvatar name={me.creator.display_name} /> : <Bone className="size-12 rounded-full" />}
    >
      {!me ? (
        <AreaSkeleton />
      ) : (
        <MeContext.Provider value={{ me, reload: load }}>
          <div className="animate-step-in motion-reduce:animate-none">
            {closed ? (
              <Card className="mb-5 border-warn/20 bg-warnBg">
                <p className="text-[14px] font-semibold text-foreground">Your creator account is closed to new work</p>
                <p className="mt-1 text-[14px] leading-relaxed text-muted">You can still finish the jobs you have open and get paid for them.</p>
              </Card>
            ) : settingUp ? (
              <SetupCard me={me} />
            ) : showCountry ? (
              <CountryBanner current={country} onSaved={load} affiliateOnly={me.setup.earn_mode === "affiliate"} />
            ) : null}
            <div className={settingUp || showCountry || closed ? "mt-8" : ""}>{children}</div>
          </div>
        </MeContext.Provider>
      )}
    </CreatorFrame>
  );
}

function AreaSkeleton() {
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-[960px]">
      <span className="sr-only">Loading your creator area.</span>
      <div aria-hidden="true">
        <div className="rounded-block border border-black/[0.06] bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <Bone className="h-5 w-56 rounded-full" />
            <Bone className="h-4 w-16 rounded-full" />
          </div>
          <div className="mt-4 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl border border-black/[0.07] px-4 py-3">
                <Bone className="size-6 shrink-0 rounded-full" />
                <Bone className="h-4 w-40 rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <Bone className="mt-10 h-8 w-48 rounded-full" />
        <Bone className="mt-4 h-4 w-full max-w-[560px] rounded-full" />
        <Bone className="mt-2 h-4 w-2/3 max-w-[400px] rounded-full" />
      </div>
    </div>
  );
}

function RailAvatar({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.[0] ?? "?").toUpperCase();
  return (
    <Link
      href="/creator/profile"
      aria-label={`${name}, your profile`}
      title={name}
      className={`${RING} flex size-12 items-center justify-center rounded-full border-2 border-white bg-[#dfe1e6] text-[14px] font-bold text-[#0e0f11] shadow-[0_2px_8px_-2px_rgba(16,18,20,0.2)]`}
    >
      {initials}
    </Link>
  );
}

function CreatorTabs({
  pathname,
  waiting,
  pendingJobs,
}: {
  pathname: string;
  waiting: { inbox: number; messages: number };
  pendingJobs: number;
}) {
  return (
    <nav aria-label="Creator area" className="flex items-center gap-1 whitespace-nowrap lg:flex-col lg:gap-2">
      {creatorTabs().map(({ href, label, Icon }) => {
        const active = isActive(pathname, href);
        const count =
          href === "/creator" ? waiting.inbox : href === "/creator/messages" ? waiting.messages : href === "/creator/jobs" ? pendingJobs : 0;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`${RING} group relative inline-flex h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-[14px] transition-colors duration-200 lg:h-auto lg:w-[80px] lg:flex-col lg:gap-2 lg:px-1 lg:py-2 lg:text-[13px] ${
              active
                ? "bg-[#0e0f11]/[0.06] font-semibold text-[#0e0f11] lg:bg-transparent"
                : "font-medium text-[#595959] hover:bg-[#0e0f11]/[0.03] hover:text-[#0e0f11] lg:text-[#1f1f1f] lg:hover:bg-transparent"
            }`}
          >
            {}
            <span
              className={`flex shrink-0 items-center justify-center lg:size-10 lg:rounded-xl lg:transition-colors ${
                active ? "lg:bg-white lg:shadow-[0_1px_3px_rgba(16,18,20,0.12)]" : "lg:group-hover:bg-white/70"
              }`}
            >
              <Icon className="size-[18px] lg:size-[22px]" strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
            </span>
            <span>{label}</span>
            {count > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[#0e0f11] px-1.5 text-[11px] font-semibold leading-5 text-white lg:absolute lg:top-0.5 lg:right-2.5">
                {count}
                {href === "/creator/jobs" ? <span className="sr-only"> pending</span> : null}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function SetupCard({ me }: { me: CreatorMe }) {
  const card = setupCardFor(me.setup);
  const done = card.rows.filter((r) => r.done).length;
  return (
    <div className="mb-5">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[16px] font-semibold text-foreground">{card.title}</p>
          <span className="text-[13px] text-muted">
            {done} of {card.rows.length} done
          </span>
        </div>
        <ul className="mt-4 space-y-2">
          {card.rows.map((c, i) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-3">
              {c.done ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-white">
                  <Check className="h-3 w-3" aria-hidden="true" />
                </span>
              ) : (
                <CircleDashed className="h-6 w-6 shrink-0 text-muted" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 text-[14px] text-foreground">
                {i + 1}. {c.label}
              </span>
              {c.done ? (
                <span className="flex items-center gap-2">
                  <StatusPill tone="good">Done</StatusPill>
                  <Link href={`/creators/apply?step=${c.id}`} className={BTN_SMALL} aria-label={`Edit ${c.label}`}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </Link>
                </span>
              ) : (
                <Link href={`/creators/apply?step=${c.id}`} className={BTN_SMALL}>
                  Start
                  <NextChevron />
                </Link>
              )}
            </li>
          ))}
          {card.extras ? (
            <>
              <li className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-black/[0.12] bg-white px-4 py-3">
                <ImageIcon className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-[14px] text-foreground">
                  Add a profile photo
                  <span className="block text-[13px] text-muted">Optional. Businesses see it on your card in Find creators.</span>
                </span>
                <Link href="/creators/apply?step=photo" className={BTN_SMALL}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add photo
                </Link>
              </li>
              <li className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-black/[0.12] bg-white px-4 py-3">
                <Video className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-[14px] text-foreground">
                  Add an intro video
                  <span className="block text-[13px] text-muted">Optional. Up to 30 seconds. Businesses see it on your card in Find creators.</span>
                </span>
                <Link href="/creator/profile" className={BTN_SMALL}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add video
                </Link>
              </li>
            </>
          ) : null}
        </ul>
      </Card>
      <p className="mt-2.5 text-[13px] text-muted">{card.footer}</p>
    </div>
  );
}

function CountryBanner({ current, onSaved, affiliateOnly = false }: { current: string | null; onSaved: () => void; affiliateOnly?: boolean }) {
  const [choice, setChoice] = useState(current && canPay(current) ? current : "");
  const [refused, setRefused] = useState<string | null>(current && !canPay(current) ? current : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await creatorApi.saveProfile({ country_code: choice });
      if (canPay(choice)) onSaved();
      else setRefused(choice);
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5 border-warn/20 bg-warnBg">
      <div className="flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/70 text-warn">
          <Globe className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">
            {!CREATOR_MARKETPLACE_ENABLED
              ? "Add your country so Zavi can complete payouts"
              : affiliateOnly
                ? "Add your country so Zavi can pay you"
                : "Add your country so businesses can book you"}
          </p>
          <p className="mt-1 text-[14px] leading-relaxed text-muted">
            {!CREATOR_MARKETPLACE_ENABLED
              ? `Existing job payouts need it. ${PAYOUT_REGIONS_LINE}.`
              : affiliateOnly
                ? `Payouts need it. ${PAYOUT_REGIONS_LINE}.`
                : `Until you add it, you are hidden from Find creators. ${PAYOUT_REGIONS_LINE}.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <div className="relative w-full max-w-[280px]">
            <select
              aria-label="Country"
              value={choice}
              onChange={(e) => {
                setChoice(e.target.value);
                setRefused(null);
              }}
              className={`${FIELD} h-12 w-full cursor-pointer appearance-none pr-11 pl-4`}
            >
              <option value="">Choose your country</option>
              {}
              {PAYABLE_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 h-4 w-4 -translate-y-1/2 text-muted" />
            </div>
            <button type="button" onClick={save} disabled={!choice || busy} className={BTN_PRIMARY}>
              Save country
            </button>
          </div>
          {}
          {refused ? (
            affiliateOnly ? (
              <p role="alert" className="mt-3 text-[14px] font-medium text-foreground">
                Payouts for {countryName(refused)} are handled by our team.
              </p>
            ) : (
              <p role="alert" className="mt-3 text-[14px] font-medium text-danger">
                We can&apos;t pay creators in {countryName(refused)} yet. We&apos;ll email you when we can.
              </p>
            )
          ) : affiliateOnly ? (
            <p className="mt-3 text-[13px] text-muted">Not in the list? Payouts for your country are handled by our team.</p>
          ) : (
            <p className="mt-3 text-[13px] text-muted">Not in the list? Zavi can&apos;t pay creators there yet.</p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-[14px] font-medium text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

export function DeadlineNote({ deadline }: { deadline: { line: string } | null }) {
  if (!deadline) return null;
  return <p className="rounded-xl border border-black/[0.07] bg-white px-4 py-3 text-[13px] leading-relaxed text-foreground">{deadline.line}</p>;
}

export function Loading({ what }: { what: string }) {
  return <UiLoading what={what} />;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-black/[0.14] bg-white/60 px-4 py-6 text-center text-[14px] leading-relaxed text-muted">
      {children}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-dangerBg px-4 py-3 text-[14px] text-danger">
      {message}
    </p>
  );
}

export function SelfReported({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-semibold">{children}</span>
      <span className="text-[12px] text-muted">(Self-reported, not checked by Zavi)</span>
    </span>
  );
}
