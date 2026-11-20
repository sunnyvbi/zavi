"use client";

import { CalendarClock, FileText, Inbox, TriangleAlert, Users, Wallet, type LucideIcon } from "lucide-react";
import { useHumanResource } from "@/components/humans/useHumanResource";
import { applicantOutcome, closedReasonLine, type BriefApplicantsResponse } from "@/components/humans/humanPostedBriefs";
import { firstName, money, shortDay, useUgcDrawer } from "./hub";
import { openIntroVideo } from "@/lib/creator/introVideo";
import { Avatar, BTN_PRIMARY, BTN_SECONDARY, CreatorProfileCard, CreatorProfileCardSkeleton, DrawerNote, SideDrawer } from "./ui";
import { useCreatorCards } from "./useCards";

const HIREABLE = new Set(["applied", "shortlisted"]);
const BTN_COMPACT_PRIMARY = BTN_PRIMARY.replace("h-10", "h-9").replace("px-4", "px-3.5");
const BTN_COMPACT_SECONDARY = BTN_SECONDARY.replace("h-10", "h-9").replace("px-4", "px-3.5");

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-rule bg-cream px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[12px] text-inkMuted">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 text-[15px] font-semibold text-ink tabular-nums">{value}</dd>
    </div>
  );
}

export function ApplicantsDrawer() {
  const drawer = useUgcDrawer();
  const briefId = drawer.params.brief ?? "";
  const res = useHumanResource<BriefApplicantsResponse>(`/api/humans/briefs/${encodeURIComponent(briefId)}/applicants`);
  const data = res.data;
  const applicants = data?.applicants ?? [];
  const cards = useCreatorCards(applicants.map((a) => a.human_member_id));
  const failed = drawer.params.hire_cancelled === "1";
  const failedApp = failed ? applicants.find((a) => a.application_id === drawer.params.application) : undefined;
  const closed = data ? closedReasonLine(data.brief) : null;

  return (
    <SideDrawer title="Applicants" onClose={drawer.close}>
      {failed && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-dangerBg px-4 py-3 text-[14px] text-ink">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          <div>
            <p className="font-semibold">
              The payment to hire {failedApp ? firstName(failedApp.display_name) : "this creator"} didn&apos;t go through.
            </p>
            <p className="mt-0.5 text-inkSoft">The brief stays open and nobody was told anything. Try again, or pick someone else.</p>
            {failedApp && (
              <button
                type="button"
                onClick={() => drawer.open("hire", { application: failedApp.application_id, brief: briefId })}
                className={`${BTN_PRIMARY} mt-3`}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}
      {!data ? (
        <DrawerNote>{res.loading ? "Loading applicants…" : "Couldn't load this brief just now."}</DrawerNote>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[20px] leading-snug font-bold text-ink">{data.brief.title || "Untitled brief"}</h2>
            <span
              className={`mt-1 shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
                data.brief.open ? "bg-successBg text-success" : "bg-bone text-inkMuted"
              }`}
            >
              {data.brief.open ? "Open" : "Closed"}
            </span>
          </div>
          {closed && <p className="mt-1 text-[13px] text-inkMuted">{closed}</p>}
          <dl className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat
              icon={Users}
              label="Applied"
              value={data.brief.applicant_cap ? `${applicants.length} of ${data.brief.applicant_cap}` : String(applicants.length)}
            />
            <Stat icon={CalendarClock} label="Answer by" value={shortDay(data.brief.answer_by) || "Not set"} />
            <Stat
              icon={Wallet}
              label="Budget"
              value={data.brief.budget_usd ? `${money(Math.round(data.brief.budget_usd * 100))} per video` : "Not set"}
            />
          </dl>
          <div className="mt-4 rounded-xl border border-rule bg-creamDeep px-4 py-3">
            <p className="text-[13px] font-semibold text-ink">When you hire someone, everyone else gets this note</p>
            <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">&ldquo;{data.decline_note}&rdquo;</p>
            <p className="mt-2 text-[12px] text-inkMuted">The brief closes once your hire payment goes through.</p>
          </div>
          <button
            type="button"
            onClick={() => drawer.open("brief", { brief: briefId })}
            className={`${BTN_SECONDARY} mt-3 inline-flex items-center gap-1.5`}
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            Read the published brief
          </button>
          <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-rule pt-4">
            <h3 className="text-[16px] font-semibold text-ink">
              {applicants.length} {applicants.length === 1 ? "applicant" : "applicants"}
            </h3>
            {data.order && <p className="text-[12px] text-inkMuted">{data.order}</p>}
          </div>
          {applicants.length === 0 ? (
            <div className="mt-3 flex flex-col items-center rounded-2xl border border-rule bg-cream px-6 py-10 text-center">
              <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-full bg-bone text-inkMuted">
                <Inbox className="h-5 w-5" />
              </span>
              <p className="mt-3 text-[15px] font-semibold text-ink">No applications yet</p>
              <p className="mt-1 max-w-sm text-[13px] leading-5 text-inkMuted">
                Creators who fit the brief get an email. Their applications show up here
                {data.brief.open && data.brief.answer_by ? `, until ${shortDay(data.brief.answer_by)}` : ""}.
              </p>
            </div>
          ) : (
            <ul className="mt-4 grid gap-3">
              {applicants.map((a) => {
                const card = cards[a.human_member_id];
                const first = firstName(a.display_name || "Creator");
                const hireable = HIREABLE.has(a.status) && a.bookable && Boolean(a.fees) && data.brief.open;
                return (
                  <li key={a.application_id} className="grid gap-2" data-testid="applicant">
                    {card === undefined ? (
                      <CreatorProfileCardSkeleton />
                    ) : card ? (
                      <CreatorProfileCard
                        creator={card}
                        onBook={(pid) => drawer.open("hire", { package: pid, brief: briefId })}
                        onPlayIntro={() => openIntroVideo(`/api/humans/creators/${encodeURIComponent(a.human_member_id)}/intro-video`, card.display_name)}
                      />
                    ) : (
                      <div className="flex items-center gap-3 rounded-2xl border border-ink/[0.07] bg-cream p-3.5">
                        <Avatar name={a.display_name || "C"} />
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-semibold text-ink">{a.display_name || "A Zavi creator"}</p>
                          <p className="text-[13px] text-inkMuted">{[a.city, a.country_code].filter(Boolean).join(", ")}</p>
                        </div>
                      </div>
                    )}
                    <div className="rounded-2xl border border-rule bg-creamDeep p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-[12px] font-semibold tracking-[0.06em] text-inkMuted uppercase">Applied to this brief</p>
                        {!HIREABLE.has(a.status) && <p className="text-[12px] font-semibold text-inkMuted">{applicantOutcome(a)}</p>}
                      </div>
                      {a.note && <p className="mt-1.5 border-l-2 border-rule pl-3 text-[14px] leading-relaxed text-ink">&ldquo;{a.note}&rdquo;</p>}
                      {!a.bookable && (
                        <p className="mt-2 text-[13px] text-inkMuted">Zavi cannot pay creators in this creator&apos;s country yet, so they cannot be hired.</p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        {a.fees ? (
                          <p className="text-[13px] text-inkMuted">
                            <span className="text-[16px] font-bold text-ink tabular-nums">{money(a.fees.price_cents)}</span> quote · you pay{" "}
                            <span className="font-semibold text-ink tabular-nums">{money(a.fees.business_total_cents)}</span> with Zavi&apos;s fee
                          </p>
                        ) : (
                          <p className="text-[13px] text-inkMuted">No quote given</p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => drawer.open("thread", { creator: a.human_member_id, brief: briefId })}
                            className={BTN_COMPACT_SECONDARY}
                          >
                            Message {first}
                          </button>
                          {hireable && (
                            <button
                              type="button"
                              onClick={() => drawer.open("hire", { application: a.application_id, brief: briefId })}
                              className={BTN_COMPACT_PRIMARY}
                            >
                              Hire and pay {money(a.fees!.business_total_cents)}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </SideDrawer>
  );
}
