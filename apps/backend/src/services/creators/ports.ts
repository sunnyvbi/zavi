
import {
  cancelCreatorHold,
  captureCreatorHold,
  refundCreatorOrder,
  transferToCreator,
} from "./orders-money";
import type { DeadlineKind } from "./deadline-copy";
import { notify, notifyBothSides, sendWindowReminder } from "./notify";

export type CreatorMoneyPort = {
  capture: typeof captureCreatorHold;
  cancelHold: typeof cancelCreatorHold;
  transfer: typeof transferToCreator;
  refund: typeof refundCreatorOrder;
};

export const realCreatorMoneyPort: CreatorMoneyPort = {
  capture: captureCreatorHold,
  cancelHold: cancelCreatorHold,
  transfer: transferToCreator,
  refund: refundCreatorOrder,
};

export type CreatorNotifyRecipient =
  | { kind: "creator"; human_member_id: string }
  | { kind: "tenant"; tenant_id: string };

export type CreatorNotifyVars = {
  job_title?: string | null;
  business_name?: string | null;
  creator_name?: string | null;
  price_cents?: number | null;
  payout_cents?: number | null;
  business_total_cents?: number | null;
  refund_cents?: number | null;
  reason?: string | null;
  note?: string | null;
  payout_waiting?: boolean | null;
  repeat_booking?: boolean | null;
  order_source?: "booking" | "offer" | "applicant" | null;
  extension?: "requested" | "approved" | "declined" | null;
  mediation?: "pay_full" | "pay_part" | "refund" | null;
  payout_sent?: boolean | null;
  extension_from?: string | null;
  extension_to?: string | null;
  deadline_kind?: DeadlineKind | null;
  deadline_at?: string | Date | null;
};

export type CreatorNotifyResult = { written: boolean; emailed: boolean };

export type CreatorNotifyPort = {
  notify(input: {
    recipient: CreatorNotifyRecipient;
    event: string;
    order_id?: string | null;
    scope_id?: string | null;
    vars?: CreatorNotifyVars;
    dedupe_key?: string | null;
    dedupe_window?: string | null;
  }): Promise<CreatorNotifyResult>;

  notifyBothSides(args: {
    event: string;
    tenant_id: string;
    human_member_id: string;
    order_id?: string | null;
    scope_id?: string | null;
    vars?: CreatorNotifyVars;
    dedupe_window?: string | null;
  }): Promise<{ creator: CreatorNotifyResult | null; tenant: CreatorNotifyResult | null }>;

  sendWindowReminder(args: {
    window: DeadlineKind;
    at_hours: 24 | 60;
    deadline_at: string | Date;
    recipient: CreatorNotifyRecipient;
    order_id?: string | null;
    scope_id?: string | null;
    vars?: CreatorNotifyVars;
  }): Promise<CreatorNotifyResult>;
};

const SENT: CreatorNotifyResult = { written: true, emailed: false };

export const noopCreatorNotifyPort: CreatorNotifyPort = {
  async notify() {
    return SENT;
  },
  async notifyBothSides() {
    return { creator: SENT, tenant: SENT };
  },
  async sendWindowReminder() {
    return SENT;
  },
};

export const realCreatorNotifyPort: CreatorNotifyPort = {
  notify,
  notifyBothSides,
  sendWindowReminder,
};
