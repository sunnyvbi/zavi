"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import { firstName, money } from "../../ugc/hub";
import { offerDue, offerWhat } from "../../ugc/offers";
import { BTN_PRIMARY, BTN_SECONDARY, Chip } from "./kit";
import type { CreatorOfferView } from "./types";

export function OfferCard({
  offer,
  creatorName,
  onAccept,
  onAct,
}: {
  offer: CreatorOfferView;
  creatorName: string;
  onAccept: () => void;
  onAct: (a: "decline" | "withdraw") => Promise<boolean | string> | void;
}) {
  const [busy, setBusy] = useState<"decline" | "withdraw" | null>(null);
  const [failed, setFailed] = useState<{ action: "decline" | "withdraw"; reason: string | null } | null>(null);
  async function run(a: "decline" | "withdraw") {
    if (busy) return;
    setBusy(a);
    setFailed(null);
    const ok = await onAct(a);
    setBusy(null);
    if (ok === false) setFailed({ action: a, reason: null });
    else if (typeof ok === "string") setFailed({ action: a, reason: ok });
  }
  const first = firstName(creatorName);
  const mine = offer.proposed_by === "tenant";
  const open = offer.status === "open" && !offer.expired;
  const accepted = offer.status === "accepted";
  const closedUnpaid = accepted && offer.closed_unpaid === true;
  const paid = accepted && !closedUnpaid && offer.awaiting_payment === false;
  const awaitingApproval = accepted && !closedUnpaid && offer.awaiting_approval === true;
  const total = money(offer.fees.business_total_cents);
  const chip = closedUnpaid ? (
    <Chip>Closed, not paid</Chip>
  ) : paid ? (
    <Chip tone="green">Paid, job started</Chip>
  ) : awaitingApproval ? (
    <Chip tone="amber">Waiting for your approval</Chip>
  ) : accepted ? (
    <Chip tone="green">{mine ? `${first} accepted` : "You accepted"}</Chip>
  ) : open ? (
    <Chip tone="amber">{mine ? `Waiting for ${first}` : "Waiting for you"}</Chip>
  ) : (
    <Chip>
      {offer.status === "declined"
        ? mine
          ? `${first} declined`
          : "You declined"
        : offer.status === "withdrawn"
          ? "Withdrawn"
          : "Expired"}
    </Chip>
  );
  const finished = !open && !accepted;
  const BTN_SM_PRIMARY = BTN_PRIMARY.replace("h-10", "h-9").replace("px-4", "px-3.5");
  const BTN_SM_SECONDARY = BTN_SECONDARY.replace("h-10", "h-9").replace("px-4", "px-3.5");
  const due = offerDue(offer);
  const dueShort = due.replace(/ after it starts$/, "");
  const facts: Array<[string, string]> = [
    [dueShort === due ? "Due" : "Due after start", dueShort],
    ["Changes", "2 rounds"],
    ["Price", money(offer.price_cents)],
  ];
  const helper = paid
    ? "Paid. The job has started and is in Your creators."
    : awaitingApproval
      ? `${first} accepted. Approve the hire card in What Zavi wants to do to pay and start the job.`
    : closedUnpaid
      ? `${mine ? `${first} accepted, but` : "You accepted, but"} this offer was not paid before it expired, so it closed. Nothing was charged and no job started. Send a new offer to work together.`
      : open
        ? mine
          ? `If ${first} accepts, you are asked to pay and the job starts.`
          : `Accept and pay charges your card now and the job starts. No 72 hour wait, because ${first} made the offer.`
        : null;
  return (
    <div
      data-testid="offer-card"
      className={`overflow-hidden rounded-2xl border bg-cream shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${
        open ? "border-ink/25" : "border-rule"
      } ${finished ? "opacity-70" : ""}`}
    >
      <div className="px-4 pt-3.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-creamDeep text-inkMuted">
            <FileText className="h-3.5 w-3.5" />
          </span>
          <p className="min-w-0 truncate text-[13px] font-medium text-inkMuted">
            {mine ? `Your custom offer to ${creatorName}` : `Custom offer from ${creatorName}`}
          </p>
          <span className="ml-auto shrink-0">{chip}</span>
        </div>
        <p className="mt-2.5 text-[17px] leading-snug font-semibold text-ink">{offerWhat(offer)}</p>
        {offer.note && <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">{offer.note}</p>}
        <dl className="mt-3 grid grid-cols-3 gap-2">
          {facts.map(([k, v]) => (
            <div key={k} className="rounded-xl bg-creamDeep px-3 py-2">
              <dt className="text-[12px] text-inkMuted">{k}</dt>
              <dd className="mt-0.5 text-[14px] font-semibold text-ink tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-rule bg-creamDeep/60 px-4 py-2.5">
        <span className="text-[13px] font-medium text-inkMuted">You pay</span>
        <span className="text-[14px] text-inkMuted">
          <span className="text-[16px] font-bold text-ink tabular-nums">{total}</span> with Zavi&apos;s 10% fee
        </span>
      </div>
      {accepted && offer.awaiting_payment ? (
        <div className="border-t border-rule bg-emerald-500/10 px-4 py-3">
          <p className="text-[14px] font-semibold text-emerald-600">{mine ? `${first} accepted` : "You accepted"}. Pay to start</p>
          <p className="mt-1 text-[13px] text-emerald-600">
            Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work.
          </p>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onAccept} className={BTN_SM_PRIMARY}>
              Pay {total}
            </button>
          </div>
        </div>
      ) : helper || open ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-3">
          {helper && <p className="min-w-0 flex-1 text-[13px] leading-5 text-inkMuted">{helper}</p>}
          {open && (
            <div className="ml-auto flex shrink-0 gap-2">
              {mine ? (
                <button type="button" onClick={() => void run("withdraw")} disabled={busy !== null} aria-busy={busy === "withdraw"} className={BTN_SM_SECONDARY}>
                  {busy === "withdraw" ? "Withdrawing..." : "Withdraw"}
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => void run("decline")} disabled={busy !== null} aria-busy={busy === "decline"} className={BTN_SM_SECONDARY}>
                    {busy === "decline" ? "Declining..." : "Decline"}
                  </button>
                  <button type="button" onClick={onAccept} disabled={busy !== null} className={BTN_SM_PRIMARY}>
                    Accept and pay
                  </button>
                </>
              )}
            </div>
          )}
          {failed && (
            <p role="alert" className="w-full text-[13px] text-red-600">
              {failed.reason ?? (failed.action === "withdraw" ? "Could not withdraw this offer. Try again." : "Could not decline this offer. Try again.")}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
