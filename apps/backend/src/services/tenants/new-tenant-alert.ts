
import { webBaseUrl } from "@/services/web-base";
import {
  SIGNUP_ATTRIBUTION_KEY,
  describeAttribution,
  parseSignupAttribution,
  type SignupAttribution,
} from "./signup-attribution";

const SENT_FLAG = "new_tenant_alert_sent";

export type NewTenantPath = "wizard" | "build_start";

export interface NewTenantAlertDeps {
  sgSend: (to: string, subject: string, html: string, text: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: () => any;
  getBoolSetting: (key: typeof SENT_FLAG, tenant_id: string) => Promise<boolean>;
  setTenantSetting: (
    tenant_id: string,
    key: typeof SENT_FLAG,
    value: unknown,
    updated_by: string,
  ) => Promise<void>;
  armFollowup: (tenant_id: string, user_id: string) => Promise<void>;
  signupAlertsEnabled: () => Promise<boolean>;
}

export const DOGFOOD_SLUGS = new Set(["upcar-ai", "upcar-private", "apna-tutor-dogfood"]);

const EMAIL_NOTE_SLUGS = ["company", "gtm_growth", "metrics_north_star"];

const GROWTH_SLUGS = ["gtm_growth", "metrics_north_star"] as const;

const TYPED_FACT_KEYS = ["company_story", "what_we_sell", "competitors"];
const TYPED_FACT_SOURCE = "human_confirmed";

export function alertRecipient(): string {
  return process.env.NEW_TENANT_ALERT_EMAIL ?? "ravi@zaviagent.com";
}

function webBase(): string {
  return webBaseUrl();
}

function adminBase(): string {
  return (process.env.ADMIN_ORIGIN || "https://admin.zaviagent.com").replace(/\/$/, "");
}

async function defaultDeps(): Promise<NewTenantAlertDeps> {
  const [{ serviceClient }, { sgSend }, settings] = await Promise.all([
    import("../supabase"),
    import("../../email/sendAuthEmail"),
    import("../settings"),
  ]);
  return {
    serviceClient,
    sgSend,
    getBoolSetting: settings.getBoolSetting,
    setTenantSetting: settings.setTenantSetting,
    armFollowup: async (tenant_id, user_id) => {
      const { armSignupFollowup } = await import("./signup-followup");
      await armSignupFollowup(tenant_id, user_id);
    },
    signupAlertsEnabled: () => settings.getBoolSetting("signup_alert_emails_enabled"),
  };
}

export type TenantSummary = {
  tenant_id: string;
  slug: string;
  display_name: string;
  path: NewTenantPath;
  created_at: string | null;
  owner_email: string | null;
  user_id: string;
  tier: string | null;
  plan?: string | null;
  attribution?: SignupAttribution | null;
  company_shape: string | null;
  product_url: string | null;
  build_app_intent: string | null;
  company_scale_segment: string | null;
  goal: { objective: string; target_metric: string | null; target_value: number | null } | null;
  brain: Array<{ slug: string; title: string; body: string }>;
  typed_facts: Partial<Record<"company_story" | "what_we_sell" | "competitors", string>>;
  generated_story: string | null;
  growth: Array<{ slug: string; title: string; body: string }>;
  unanswered_growth: string[];
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripHeadingMarkers(s: string): string {
  return s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
}

export function clip(s: string, max = 600): string {
  const withoutTitle = s.replace(/^[ \t]*#{1,6}[ \t]+[^\n]*(?:\n|$)/, "");
  const body = withoutTitle.trim() ? withoutTitle : s;
  const flat = stripHeadingMarkers(body).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const PLACEHOLDER_MARKERS = ["Edit this anchor", "Set this up —"];

export function isPlaceholderBrainBody(body: string): boolean {
  return PLACEHOLDER_MARKERS.some((m) => body.includes(m));
}

const BRAIN_TITLES: Record<string, string> = {
  company: "Company",
  gtm_growth: "How they get customers",
  metrics_north_star: "North-star metric",
};

const PATH_LABEL: Record<NewTenantPath, string> = {
  wizard: "Grow wizard (has a company)",
  build_start: "Build an app (idea-first)",
};

const ANSWER_LABELS: Array<[RegExp, keyof WizardAnswers | null]> = [
  [/^who it is for:\s*/i, "audience"],
  [/^focus first:\s*/i, "focus"],
  [/^website:\s*/i, null],
  [/^founder-confirmed competitors to track:\s*/i, null],
];

export type WizardAnswers = { sells: string; audience: string; focus: string };

export function parseWizardAnswers(text: string): WizardAnswers | null {
  const out: WizardAnswers = { sells: "", audience: "", focus: "" };
  const sells: string[] = [];
  let labelled = false;
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    const hit = ANSWER_LABELS.find(([re]) => re.test(p));
    if (!hit) {
      sells.push(p);
      continue;
    }
    labelled = true;
    const [re, field] = hit;
    if (field) out[field] = p.replace(re, "").trim();
  }
  if (!labelled) return null;
  out.sells = sells.join(" ");
  return out;
}

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com",
  "yandex.com", "qq.com", "163.com", "mail.com",
]);

const THROWAWAY_ANSWERS = new Set([
  "all", "everything", "everyone", "anyone", "anything", "na", "n/a", "none", "nothing",
  "test", "testing", "asdf", "idk", "x", "xx", "xxx", "-", ".", "?", "abc", "hi", "hello",
]);

function isThrowaway(answer: string): boolean {
  const a = answer.trim().toLowerCase().replace(/[.!]+$/, "");
  return a.length < 3 || THROWAWAY_ANSWERS.has(a);
}

export function signalLine(s: TenantSummary): { verdict: "real" | "mixed" | "low"; line: string } {
  const reasons: string[] = [];
  const domain = (s.owner_email ?? "").split("@")[1]?.toLowerCase() ?? "";
  if (!domain) reasons.push("no email on file");
  else if (PERSONAL_EMAIL_DOMAINS.has(domain)) reasons.push("personal email");
  if (!s.product_url) reasons.push("no website");
  const typed = (s.typed_facts.company_story ?? s.typed_facts.what_we_sell ?? "").trim();
  const answers = typed ? parseWizardAnswers(typed) : null;
  const given = answers ? [answers.sells, answers.audience, answers.focus].filter(Boolean) : typed ? [typed] : [];
  const junk = given.filter(isThrowaway);
  if (!typed && s.path === "wizard") reasons.push("typed no description");
  else if (junk.length) reasons.push(`throwaway answers (${junk.map((j) => `"${clip(j, 20)}"`).join(", ")})`);

  if (!reasons.length) return { verdict: "real", line: "Looks real: work email, website given, real answers" };
  const verdict = reasons.length >= 2 ? "low" : "mixed";
  return { verdict, line: `${verdict === "low" ? "Low signal" : "Mixed signal"}: ${reasons.join(", ")}` };
}

export function formatCreatedPt(iso: string | null): string {
  if (!iso) return "(unknown)";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "medium",
    timeStyle: "short",
  })} PT`;
}

export type WordsSection = {
  banner: string;
  blocks: Array<{ title: string; body: string }>;
};

export function wordsBlock(s: TenantSummary): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  const story = (s.typed_facts.company_story ?? "").trim();
  const sells = (s.typed_facts.what_we_sell ?? "").trim();
  const typed = story || sells;
  if (typed) {
    const answers = parseWizardAnswers(typed);
    if (!answers) {
      out.push({ title: "In their words", body: clip(typed, 1200) });
    } else {
      const unanswered = "(left blank)";
      out.push({ title: "What they sell", body: answers.sells ? clip(answers.sells, 800) : unanswered });
      out.push({ title: "Who it's for", body: answers.audience ? clip(answers.audience, 300) : unanswered });
      out.push({ title: "Focus first", body: answers.focus ? clip(answers.focus, 300) : unanswered });
    }
  } else {
    const generated = (s.generated_story ?? "").trim() || s.brain.find((b) => b.slug === "company")?.body;
    if (generated) {
      out.push({
        title: "Company (written by onboarding, not typed by them)",
        body: clip(generated, 1200),
      });
    }
  }
  const competitors = (s.typed_facts.competitors ?? "").trim();
  if (competitors) {
    out.push({ title: "Competitors (found by our enrichment, not stated by them)", body: clip(competitors, 300) });
  }
  return out;
}

export function wordsSection(s: TenantSummary): WordsSection {
  const blocks = wordsBlock(s);
  const quoted = Boolean((s.typed_facts.company_story ?? s.typed_facts.what_we_sell ?? "").trim());
  if (!blocks.length) return { banner: "What they told us", blocks };
  if (quoted) return { banner: "What they told us, in their own words", blocks };
  return { banner: "What we know about the company (not typed by them)", blocks };
}

export function growthAnswerLines(s: TenantSummary): Array<[string, string]> {
  const answered = new Map(s.growth.map((g) => [g.slug, g.body]));
  return GROWTH_SLUGS.map((slug) => [
    BRAIN_TITLES[slug] ?? slug,
    answered.get(slug) ?? "(not answered)",
  ]);
}

const SIGNAL_COLOR = { real: "#15803d", mixed: "#b45309", low: "#b91c1c" } as const;

export function renderNewTenantEmail(s: TenantSummary): {
  subject: string;
  html: string;
  text: string;
} {
  const name = s.display_name || s.slug;
  const subject = `New Zavi signup: ${name}${s.owner_email ? ` (${s.owner_email})` : ""}`;

  const signal = signalLine(s);
  const facts: Array<[string, string]> = [
    ["Company", name],
    ["Owner", s.owner_email ?? "(no email on file)"],
    ["Signed up via", PATH_LABEL[s.path]],
    ["Website", s.product_url ?? "(none given)"],
    ["Shape", s.company_shape ?? "(unclassified)"],
    ["Size", s.company_scale_segment ?? "(not stated)"],
    ["Plan", s.plan ?? "(unknown)"],
    ["Came from", describeAttribution(s.attribution)],
    ["Wants", s.build_app_intent === "fresh" ? "an app built from scratch" : "growth on an existing product"],
    ["Slug", s.slug],
    ["Created", formatCreatedPt(s.created_at)],
  ];
  if (s.goal) {
    const target =
      s.goal.target_metric && s.goal.target_value !== null
        ? ` (${s.goal.target_metric} → ${s.goal.target_value})`
        : "";
    facts.push(["Goal", `${s.goal.objective}${target}`]);
  } else {
    facts.push(["Goal", "(not set)"]);
  }

  const workspace = `${webBase()}/workspace`;
  const console_ = `${adminBase()}/tenants/${s.tenant_id}`;

  const textFacts = facts.map(([k, v]) => `${k.padEnd(14)} ${v}`).join("\n");

  const { banner: wordsBanner, blocks: words } = wordsSection(s);
  const growthLines = growthAnswerLines(s);

  const textWords = words.length
    ? words.map((w) => `## ${w.title}\n${w.body}`).join("\n\n")
    : "(nothing typed — this tenant came in on the build path, or skipped the description)";
  const textGrowth = growthLines.map(([k, v]) => `## ${k}\n${v}`).join("\n\n");
  const text = [
    `${name} just created a Zavi workspace.`,
    signal.line,
    ``,
    textFacts,
    ``,
    `— ${wordsBanner} —`,
    ``,
    textWords,
    ``,
    `— Growth answers —`,
    ``,
    textGrowth,
    ``,
    `Staff console: ${console_}`,
    `Workspace:     ${workspace}`,
    ``,
    `You're getting this because NEW_TENANT_ALERT_EMAIL points here. Test and dogfood tenants are excluded.`,
  ].join("\n");

  const htmlFacts = facts
    .map(
      ([k, v]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:4px 0;color:#111;font-size:13px;">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join("");
  const htmlWords = words.length
    ? words
        .map(
          (w) => `
        <div style="margin:0 0 16px 0;">
          <div style="font-size:13px;font-weight:600;color:#111;">${escapeHtml(w.title)}</div>
          <div style="margin-top:4px;color:#444;font-size:13px;line-height:1.5;">${escapeHtml(w.body)}</div>
        </div>`,
        )
        .join("")
    : `<div style="color:#888;font-size:13px;">Nothing typed — this tenant came in on the build path, or skipped the description.</div>`;
  const htmlGrowth = growthLines
    .map(
      ([k, v]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:4px 0;font-size:13px;color:${v === "(not answered)" ? "#b45309" : "#111"};">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join("");

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <p style="font-size:15px;margin:0 0 6px 0;"><strong>${escapeHtml(name)}</strong> just created a Zavi workspace.</p>
      <p style="font-size:13px;margin:0 0 16px 0;font-weight:600;color:${SIGNAL_COLOR[signal.verdict]};">${escapeHtml(signal.line)}</p>
      <table style="border-collapse:collapse;margin:0 0 24px 0;">${htmlFacts}</table>
      <div style="font-size:12px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px 0;">${escapeHtml(wordsBanner)}</div>
      ${htmlWords}
      <div style="font-size:12px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.04em;margin:24px 0 10px 0;">Growth answers</div>
      <table style="border-collapse:collapse;margin:0 0 8px 0;">${htmlGrowth}</table>
      <p style="margin:24px 0 0 0;font-size:13px;">
        <a href="${escapeHtml(console_)}" style="color:#111;">Staff console</a> ·
        <a href="${escapeHtml(workspace)}" style="color:#111;">Workspace</a>
      </p>
      <p style="margin:20px 0 0 0;color:#999;font-size:11px;">Sent because NEW_TENANT_ALERT_EMAIL points here. Test and dogfood tenants are excluded.</p>
    </div>`;

  return { subject, html, text };
}

const PAID_PLANS = new Set(["starter", "growth", "pro"]);
const ACTIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due"]);

export function planFromSubscription(
  row: { tier?: string | null; status?: string | null; comp_expires_at?: string | null } | null,
  now: Date,
): string {
  if (!row || !row.tier || !PAID_PLANS.has(row.tier)) return "free";
  if (row.comp_expires_at) {
    return new Date(row.comp_expires_at).getTime() > now.getTime() ? `${row.tier} (comp)` : "free";
  }
  return ACTIVE_SUB_STATUSES.has(row.status ?? "") ? row.tier : "free";
}

export type NewTenantAlertOutcome =
  | { sent: true }
  | { sent: false; reason: string };

export async function notifyNewTenant(
  args: { tenant_id: string; user_id: string; path: NewTenantPath },
  injected?: Partial<NewTenantAlertDeps>,
): Promise<NewTenantAlertOutcome> {
  try {
    const base = await defaultDeps();
    const deps: NewTenantAlertDeps = { ...base, ...injected };
    const sb = deps.serviceClient();

    if (await deps.getBoolSetting(SENT_FLAG, args.tenant_id)) {
      return { sent: false, reason: "already_sent" };
    }
    if (!(await deps.signupAlertsEnabled())) return { sent: false, reason: "muted" };

    const { data: tenant, error: tErr } = await sb
      .from("tenants")
      .select("id, slug, display_name, created_at, kind, tier, company_shape, product_url")
      .eq("id", args.tenant_id)
      .maybeSingle();
    if (tErr) return { sent: false, reason: `tenant_read_failed: ${tErr.message}` };
    if (!tenant) return { sent: false, reason: "tenant_not_found" };

    if (tenant.kind === "test") return { sent: false, reason: "skipped_test_tenant" };
    if (DOGFOOD_SLUGS.has(tenant.slug)) return { sent: false, reason: "skipped_dogfood_tenant" };

    let owner_email: string | null = null;
    try {
      const { data: u } = await sb.auth.admin.getUserById(args.user_id);
      owner_email = u?.user?.email ?? null;
    } catch {
    }

    const brain: TenantSummary["brain"] = [];
    const growth: TenantSummary["growth"] = [];
    const { data: notes, error: nErr } = await sb
      .from("memory_note")
      .select("slug, title, body_markdown")
      .eq("tenant_id", args.tenant_id)
      .in("slug", EMAIL_NOTE_SLUGS);
    if (nErr) return { sent: false, reason: `memory_note_read_failed: ${nErr.message}` };
    const bySlug = new Map(
      ((notes ?? []) as Array<{ slug: string; title: string | null; body_markdown: string | null }>)
        .map((n) => [n.slug, n]),
    );
    const unanswered_growth: string[] = [];
    for (const slug of EMAIL_NOTE_SLUGS) {
      const n = bySlug.get(slug);
      const body = clip(n?.body_markdown ?? "");
      const isGrowth = (GROWTH_SLUGS as readonly string[]).includes(slug);
      if (!body || isPlaceholderBrainBody(body)) {
        if (isGrowth) unanswered_growth.push(slug);
        continue;
      }
      const entry = {
        slug,
        title: BRAIN_TITLES[slug] ?? slug,
        body,
      };
      (isGrowth ? growth : brain).push(entry);
    }

    const typed_facts: TenantSummary["typed_facts"] = {};
    let generated_story: string | null = null;
    const { data: factRows, error: fErr } = await sb
      .from("tenant_fact")
      .select("key, value_text, source")
      .eq("tenant_id", args.tenant_id)
      .in("key", TYPED_FACT_KEYS);
    if (fErr) return { sent: false, reason: `tenant_fact_read_failed: ${fErr.message}` };
    for (const r of (factRows ?? []) as Array<{
      key: string;
      value_text: string | null;
      source: string | null;
    }>) {
      const v = (r.value_text ?? "").trim();
      if (!v || !TYPED_FACT_KEYS.includes(r.key)) continue;
      if (r.key !== "competitors" && r.source !== TYPED_FACT_SOURCE) {
        if (r.key === "company_story") generated_story = v;
        continue;
      }
      typed_facts[r.key as keyof TenantSummary["typed_facts"]] = v;
    }

    const { data: goals, error: gErr } = await sb
      .from("autopilot_goals")
      .select("objective, target_metric, target_value")
      .eq("tenant_id", args.tenant_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (gErr) return { sent: false, reason: `goals_read_failed: ${gErr.message}` };
    const goalRow = (goals ?? [])[0] as
      | { objective: string; target_metric: string | null; target_value: number | null }
      | undefined;

    const { data: settingRows } = await sb
      .from("tenant_app_setting")
      .select("key, value")
      .eq("tenant_id", args.tenant_id)
      .in("key", ["build_app_intent", "company_scale_segment", SIGNUP_ATTRIBUTION_KEY]);
    const settingOf = (key: string): string | null => {
      const row = ((settingRows ?? []) as Array<{ key: string; value: unknown }>).find(
        (r) => r.key === key,
      );
      const v = row?.value;
      return typeof v === "string" && v.length > 0 ? v : null;
    };

    const attributionRow = ((settingRows ?? []) as Array<{ key: string; value: unknown }>).find(
      (r) => r.key === SIGNUP_ATTRIBUTION_KEY,
    );

    let plan: string | null = null;
    const { data: sub, error: subErr } = await sb
      .from("tenant_subscriptions")
      .select("tier, status, comp_expires_at")
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    if (!subErr) plan = planFromSubscription(sub ?? null, new Date());

    const productUrl = tenant.product_url as { marketing?: string } | string | null;

    const summary: TenantSummary = {
      tenant_id: args.tenant_id,
      slug: tenant.slug,
      display_name: tenant.display_name ?? tenant.slug,
      path: args.path,
      created_at: tenant.created_at ?? null,
      owner_email,
      user_id: args.user_id,
      tier: tenant.tier ?? null,
      plan,
      attribution: parseSignupAttribution(attributionRow?.value),
      company_shape: tenant.company_shape ?? null,
      product_url:
        typeof productUrl === "string"
          ? productUrl
          : (productUrl?.marketing ?? null),
      build_app_intent: settingOf("build_app_intent"),
      company_scale_segment: settingOf("company_scale_segment"),
      goal: goalRow
        ? {
            objective: goalRow.objective,
            target_metric: goalRow.target_metric,
            target_value: goalRow.target_value,
          }
        : null,
      brain,
      typed_facts,
      generated_story,
      growth,
      unanswered_growth,
    };

    const rendered = renderNewTenantEmail(summary);
    await deps.sgSend(alertRecipient(), rendered.subject, rendered.html, rendered.text);

    await deps.setTenantSetting(args.tenant_id, SENT_FLAG, true, args.user_id);

    try {
      await deps.armFollowup(args.tenant_id, args.user_id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[new-tenant-alert] 24h follow-up not armed for ${args.tenant_id}: ${(e as Error).message}`);
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
