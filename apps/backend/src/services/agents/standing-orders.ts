
import { z } from "zod";
import { chatFailureBubbleBody } from "./error-body";
import { channelForAgent } from "./channel-agents";
import { githubTokenRegex } from "@/services/security/github-token-pattern";

export const STANDING_ORDER_PROMPT_MAX = 5000;
export const PAYLOAD_TEMPLATE_MAX_JSON_CHARS = 8000;

export function standingOrderThreadOwners(agent_slug: string): string[] {
  return channelForAgent(agent_slug) ? [agent_slug, "operator"] : [agent_slug];
}

function intlZoneValid(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const standingOrderEmailTarget = z.object({
  kind: z.literal("email"),
});

export const standingOrderDeliverSchema = z.union([
  z.object({
    kind: z.literal("chat_thread"),
    thread_id: z.string().regex(UUID_RE, "thread_id must be a uuid"),
  }),
  z.object({
    kind: z.literal("slack_channel"),
    channel_id: z
      .string()
      .regex(SLACK_CHANNEL_RE, "channel_id must be a Slack channel id (C0...)"),
  }),
  standingOrderEmailTarget,
]);

export const standingOrderSchema = z.object({
  prompt: z.string().min(1).max(STANDING_ORDER_PROMPT_MAX),
  deliver: standingOrderDeliverSchema,
});

export type StandingOrder = z.infer<typeof standingOrderSchema>;

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "anthropic/openai-style api key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github token", re: githubTokenRegex() },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

export function findSecretLiteral(text: string): string | null {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return null;
}

export type PayloadTemplateValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function validatePayloadTemplate(
  input: unknown,
): PayloadTemplateValidation {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return { ok: false, error: "payload_template must be a JSON object" };
  }
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return { ok: false, error: "payload_template must be JSON-serializable" };
  }
  if (json.length > PAYLOAD_TEMPLATE_MAX_JSON_CHARS) {
    return {
      ok: false,
      error: `payload_template too large (${json.length} chars > ${PAYLOAD_TEMPLATE_MAX_JSON_CHARS})`,
    };
  }
  const secret = findSecretLiteral(json);
  if (secret) {
    return {
      ok: false,
      error: `payload_template appears to contain a secret (${secret}) — remove it; scheduled runs must never carry credentials`,
    };
  }
  const obj = input as Record<string, unknown>;
  if ("standing_order" in obj) {
    const parsed = standingOrderSchema.safeParse(obj.standing_order);
    if (!parsed.success) {
      return {
        ok: false,
        error: `standing_order invalid: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }
  }
  return { ok: true, value: obj };
}

export const createStandingOrderDecisionBody = z.object({
  cron_expression: z.string().min(1).max(64),
  standing_order: standingOrderSchema,
  timezone: z.string().min(1).max(64).optional(),
});

export type CreateStandingOrderDeps = {
  upsertScheduleRow: (row: {
    tenant_id: string;
    agent_slug: string;
    cron_expression: string;
    enabled: boolean;
    payload_template: Record<string, unknown>;
    timezone?: string;
  }) => Promise<{ error: { message: string } | null }>;
  validateCron: (cron: string) => string | null;
  validateTimeZone?: (tz: string) => boolean;
};

async function createScheduleFromDecision(
  tenant_id: string,
  body: unknown,
  deps: CreateStandingOrderDeps,
  target_agent_slug: string,
  label: string,
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const parsed = createStandingOrderDecisionBody.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `${label} body invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const cronErr = deps.validateCron(parsed.data.cron_expression);
  if (cronErr) {
    return { ok: false, error: `invalid cron_expression: ${cronErr}` };
  }
  const tpl = validatePayloadTemplate({
    standing_order: parsed.data.standing_order,
  });
  if (!tpl.ok) {
    return { ok: false, error: tpl.error };
  }
  const timezone = parsed.data.timezone?.trim();
  if (timezone !== undefined) {
    const valid = deps.validateTimeZone ?? intlZoneValid;
    if (!timezone || !valid(timezone)) {
      return { ok: false, error: `invalid timezone: ${timezone || "(empty)"} is not an IANA zone` };
    }
  }
  const { error } = await deps.upsertScheduleRow({
    tenant_id,
    agent_slug: target_agent_slug,
    cron_expression: parsed.data.cron_expression.trim(),
    enabled: true,
    payload_template: tpl.value,
    ...(timezone ? { timezone } : {}),
  });
  if (error) {
    return { ok: false, error: `schedule write failed: ${error.message}` };
  }
  const deliver = parsed.data.standing_order.deliver;
  const dest =
    deliver.kind === "chat_thread"
      ? "this chat thread"
      : deliver.kind === "email"
        ? "your workspace's email recipients"
        : `Slack <#${deliver.channel_id}>`;
  const when = timezone ? ` (${timezone})` : "";
  return {
    ok: true,
    notice: `✅ ${label} active — runs on \`${parsed.data.cron_expression.trim()}\`${when}, result posts to ${dest}. (One per tenant per agent; this replaced any previous one.)`,
  };
}

export async function createStandingOrderFromDecision(
  tenant_id: string,
  body: unknown,
  deps: CreateStandingOrderDeps,
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  return createScheduleFromDecision(
    tenant_id,
    body,
    deps,
    "operator",
    "Standing order",
  );
}

export async function createResearchWatchFromDecision(
  tenant_id: string,
  body: unknown,
  deps: CreateStandingOrderDeps,
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  return createScheduleFromDecision(
    tenant_id,
    body,
    deps,
    "research",
    "Research watch",
  );
}

export async function createChannelStandingOrderFromDecision(
  tenant_id: string,
  body: unknown,
  deps: CreateStandingOrderDeps,
  run_agent_slug: string,
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const channel = channelForAgent(run_agent_slug);
  if (!channel) {
    return {
      ok: false,
      error: `channel standing order refused: ${run_agent_slug} does not own a channel`,
    };
  }
  return createScheduleFromDecision(
    tenant_id,
    body,
    deps,
    run_agent_slug,
    `${channel.name} schedule`,
  );
}

export type StandingOrderDeliveryDeps = {
  postToThread: (args: {
    thread_id: string;
    tenant_id: string;
    run_id: string;
    body: string;
  }) => Promise<string | null>;
  postToSlack: (args: {
    tenant_id: string;
    run_id: string;
    channel_id: string;
    text: string;
  }) => Promise<string | null>;
  postToEmail: (args: {
    tenant_id: string;
    run_id: string;
    agent_slug: string;
    body: string;
  }) => Promise<string | null>;
  scrub: (text: string) => string;
};

const DELIVERY_BODY_MAX = 32000;

export function composeStandingOrderBody(args: {
  status: "success" | "error" | "failed" | "cancelled";
  output_text: string | null;
  error: string | null;
  agent_slug?: string;
}): string {
  const header = "🕒 Scheduled brief";
  let body: string;
  if (args.status === "success" && args.output_text && args.output_text.length > 0) {
    body = `${header}\n\n${args.output_text}`;
  } else if (args.status === "success") {
    body = `${header}\n\n(The scheduled run finished but produced no text.)`;
  } else {
    const safeDetail = args.error
      ? chatFailureBubbleBody(args.error, args.agent_slug ?? "operator")
      : `the run ended with status: ${args.status}`;
    body = `${header} — the scheduled run did not complete.\n\n${safeDetail}\n\nIt will run again on its next schedule.`;
  }
  return body.length > DELIVERY_BODY_MAX ? body.slice(0, DELIVERY_BODY_MAX) : body;
}

export async function deliverStandingOrderResult(
  args: {
    tenant_id: string;
    run_id: string;
    status: "success" | "error" | "failed" | "cancelled";
    output_text: string | null;
    error: string | null;
    payload: unknown;
    agent_slug?: string;
  },
  deps: StandingOrderDeliveryDeps,
): Promise<string | null> {
  const so =
    args.payload && typeof args.payload === "object"
      ? (args.payload as { standing_order?: unknown }).standing_order
      : undefined;
  const parsed = standingOrderSchema.safeParse(so);
  if (!parsed.success) {
    return `standing_order payload malformed: ${parsed.error.issues
      .map((i) => i.message)
      .join("; ")}`;
  }
  const body = deps.scrub(
    composeStandingOrderBody({
      status: args.status,
      output_text: args.output_text,
      error: args.error,
      agent_slug: args.agent_slug,
    }),
  );
  const deliver = parsed.data.deliver;
  if (deliver.kind === "chat_thread") {
    return deps.postToThread({
      thread_id: deliver.thread_id,
      tenant_id: args.tenant_id,
      run_id: args.run_id,
      body,
    });
  }
  if (deliver.kind === "email") {
    return deps.postToEmail({
      tenant_id: args.tenant_id,
      run_id: args.run_id,
      agent_slug: args.agent_slug ?? "operator",
      body,
    });
  }
  return deps.postToSlack({
    tenant_id: args.tenant_id,
    run_id: args.run_id,
    channel_id: deliver.channel_id,
    text: body.slice(0, 39000),
  });
}
