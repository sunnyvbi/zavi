import type { CardCopy } from "./cardCopy";

export type TenantChannelView = {
  channel_slug: string;
  delivery_mode: "advise" | "produce" | "execute";
  work_state: "idle" | "running" | "needs_review" | "delivered";
  priority: number;
  last_run_at: string | null;
  connected: boolean;
  connectors: string[];
  runnable?: boolean;
  locked?: boolean;
  locked_tier?: string | null;
  run_reserve_credits?: number;
};

export type ChannelsResponse = {
  channels: TenantChannelView[];
  channel_locks?: Record<string, unknown>;
  tenant_tier?: string | null;
};

export type RecipeDeliverable = {
  kind?: string;
  label?: string;
  content?: string;
};

export type RecipeStep = {
  title?: string;
  body?: string;
  blocking?: boolean;
  effort?: string;
  evidence?: string[];
  deliverable?: RecipeDeliverable;
};

export type ChannelDecisionBody = {
  step?: RecipeStep;
  channel?: string;
  payload?: { text?: string; thread?: string[] };
  scheduled_at?: string | null;
  [key: string]: unknown;
};

export type ActionSource = "decision" | "channel_action";

export type CardKind =
  | "executes"
  | "post"
  | "plan"
  | "message"
  | "ad_manual"
  | "copy_to_site"
  | "task";

export type ChannelDecision = {
  id: string;
  decision_class: string;
  status: string;
  action_source?: ActionSource;
  exec_class?: string | null;
  emitted_at?: string;
  channel_slug?: string | null;
  run_group?: { run_id: string; position: number; of: number } | null;
  title?: string | null;
  body: ChannelDecisionBody | null;
  card_kind?: string | null;
  primary_label?: string | null;
  done_label?: string | null;
  how_to?: string[];
  steps_done?: number[];
  blocking?: boolean;
  redo_of?: string | null;
  exec_status?: string | null;
  exec_fix_text?: string | null;
  exec_receipt?: { line: string; url?: string } | null;
  approve_on_phone?: boolean;
  approve_needs_admin?: boolean;
  approve_money?: ApproveMoney;
  email_card?: boolean;
  from_signup_preview_at?: string | null;
};

export type ApproveMoney = { daily_usd: number; monthly_usd: number } | { total_usd: number };

export type ChangeRow = { item: string; before: string; after: string };

export type ApprovalsResponse = {
  decisions: ChannelDecision[];
  channel_pending_counts?: Record<string, number>;
};

export type ApproveActionResponse = {
  ok: true;
  decision_id: string;
  allowlisted?: boolean;
};

export type RedoActionResponse = {
  ok: true;
  run_id: string;
  redo_of_decision_id: string;
};

export type RunChannelResponse = {
  ok: true;
  run_id: string | null;
  stamped: boolean;
  duplicate?: boolean;
};

export type ChannelRowState = "idle" | "working" | "ready" | "completed";

export type ChannelListItem = {
  slug: string;
  name: string;
  description: string;
  state: ChannelRowState;
  pendingCount: number;
  locked: boolean;
  runnable: boolean;
  connected: boolean;
  needsConnect: boolean;
  actionLabel: string;
};

export type ChannelAction = {
  id: string;
  status?: string;
  action_source: ActionSource;
  slug: string;
  channelName: string;
  kind: "social" | "recipe" | "other";
  title: string;
  text: string;
  why: string | null;
  charLimit: number;
  canPost: boolean;
  canRewrite: boolean;
  canEdit: boolean;
  deliverableLabel: string | null;
  cardKind: CardKind | null;
  primaryLabel: string | null;
  doneLabel: string | null;
  howTo: string[];
  stepsDone: number[];
  link: string | null;
  executable: boolean;
  blocking: boolean;
  rewritten: boolean;
  weeksOld: number | null;
  intent: string | null;
  execStatus: string | null;
  execFixText: string | null;
  execReceipt: { line: string; url: string | null } | null;
  approveOnPhone: boolean;
  approveNeedsAdmin: boolean | null;
  approveMoney: ApproveMoney | null;
  changeRows: ChangeRow[];
  emailCard: boolean;
  copy: CardCopy | null;
};

export type SaveStepsResponse = { ok: true; steps_done: number[] };
