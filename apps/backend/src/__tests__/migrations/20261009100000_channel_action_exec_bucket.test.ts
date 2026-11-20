import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261009100000_channel_action_exec_bucket.sql";
const META_READINESS = "20261016190000_meta_ad_readiness_exec_fixes.sql";
const EMAIL_SEND = "20261022090100_email_campaign_tool_send.sql";
const AD_BUDGET_FIX = "20261022130000_ad_budget_refusal_exec_fix.sql";
const SEO_PR = "20261024150500_site_pull_request_cards.sql";
const REDDIT_CODES = "20261026090000_reddit_ads_invalid_request_exec_codes.sql";
const ALERT_PER_CODE = "20261031090000_exec_blocked_alert_per_code.sql";
const CODE_GROUPS = "20261031150000_exec_blocked_code_groups.sql";
const SENDGRID_NOTE = "20261031190100_exec_blocked_note_sendgrid.sql";
const CONTENT_CODES = "20261031191400_email_content_verify_codes.sql";
const AUDIENCE_TERMS = "20261104090000_meta_custom_audience_terms_needs_founder.sql";
const TERMS_CODE = "20261107090100_meta_custom_audience_terms_code.sql";
const LAUNCH_UNDONE = "20261108200000_chatgpt_launch_undone_code.sql";
const META_100_33 = "20261112160000_meta_100_33_needs_founder.sql";
const LINKEDIN_NEW_CAMPAIGN = "20261119120000_linkedin_ads_refused_post_not_retryable.sql";
const GROWTH_J6 = "20261115000100_growth_j6_founder_stop_and_diagnosis.sql";
const sql = read(FILE);
const strip = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const norm = (s: string) => strip(s).replace(/\s+/g, " ").trim();
const fn = (s: string, name: string) => {
  const i = s.indexOf(`create or replace function ${name}(`);
  expect(i, name).toBeGreaterThanOrEqual(0);
  const open = s.indexOf("$$", i);
  return s.slice(i, s.indexOf("$$;", open + 2) + 3);
};
const definers = (name: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => new RegExp(`create\\s+or\\s+replace\\s+function\\s+(public\\.)?${name}\\s*\\(`, "i").test(read(f)))
    .sort();

describe(FILE, () => {
  it("rebuilds each RPC from its LATEST definition, and nothing later redefines it", () => {
    expect(definers("settle_channel_action_exec").slice(-3)).toEqual(["20260928220000_settle_channel_action_exec_cgo_actor.sql", FILE, GROWTH_J6]);
    expect(definers("set_channel_action_video_media").slice(-2)).toEqual(["20260930080300_set_channel_action_video_media.sql", FILE]);
    for (const f of ["stamp_channel_action_exec_verdict",
      "list_failed_open_channel_actions", "enqueue_ops_alert", "claim_ops_alerts", "finish_ops_alert"]) {
      expect(definers(f), f).toEqual([FILE]);
    }
    expect(definers("exec_blocked_note")).toEqual([FILE, "20261016170000_linkedin_ads_write_rail.sql", EMAIL_SEND, SEO_PR, SENDGRID_NOTE]);
    expect(definers("apply_exec_failure_verdict")).toEqual([FILE, META_READINESS, AD_BUDGET_FIX, ALERT_PER_CODE, AUDIENCE_TERMS, LAUNCH_UNDONE, LINKEDIN_NEW_CAMPAIGN]);
    expect(definers("classify_exec_failure")).toEqual([FILE, META_READINESS, EMAIL_SEND, AD_BUDGET_FIX, SEO_PR, REDDIT_CODES, ALERT_PER_CODE, CODE_GROUPS, CONTENT_CODES, AUDIENCE_TERMS, TERMS_CODE, LAUNCH_UNDONE, META_100_33, LINKEDIN_NEW_CAMPAIGN]);
    for (const f of ["approve_channel_action", "claim_channel_action_exec", "settle_channel_action_exec"]) {
      expect(definers(f), f).not.toContain(EMAIL_SEND);
    }
  });

  it("the Growth J6 settle is this one plus the founder-stop close and nothing else", () => {
    const mine = norm(fn(read(GROWTH_J6), "settle_channel_action_exec"));
    const unwrapped = mine.replace(/if p_result->>'code' = 'founder_stopped' .*? else (perform apply_exec_failure_verdict\([^)]*\);) end if;/, "$1");
    expect(unwrapped).not.toBe(mine);
    expect(unwrapped).toBe(norm(fn(sql, "settle_channel_action_exec")));
  });

  it("the Meta 100/33 redefinition is the prior classifier plus one branch and nothing else", () => {
    const branch = "elsif v_num = 100 then";
    const meta = "v_meta := 'meta_' || v_m[1] || coalesce('_' || v_m[2], '');";
    const before = norm(fn(read(LAUNCH_UNDONE), "classify_exec_failure"));
    expect(before.split(branch)).toHaveLength(2);
    expect(before.split(meta)).toHaveLength(2);
    expect(norm(fn(read(META_100_33), "classify_exec_failure"))).toBe(
      before
        .replace(meta, `v_m[2] := coalesce(v_m[2], (regexp_match(v_text, '"error_subcode":\\s*(\\d+)[^}]*"code":\\s*\\d+'))[1]); ${meta}`)
        .replace(branch, "elsif v_num = 100 and v_m[2] = '33' then return jsonb_build_object('bucket', 'needs_founder', 'fix', 'permission', 'platform_code', v_meta); elsif v_num = 100 then"),
    );
    expect(read(META_100_33)).toContain("revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;");
  });

  it("the LinkedIn new-campaign redefinitions are the prior definitions plus the named edit and nothing else", () => {
    const later = read(LINKEDIN_NEW_CAMPAIGN);
    const row = "('chatgpt_ads_launch_undone', 'blocked_on_us', null)";
    const before = norm(fn(read(META_100_33), "classify_exec_failure"));
    expect(before.split(row)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(
      before.replace(row, `${row}, ('linkedin_ads_post_author_refused', 'blocked_on_us', null), ('linkedin_ads_account_changed', 'blocked_on_us', null)`),
    );
    const note = "case when v_row.exec_result->>'code' = 'chatgpt_ads_launch_undone' then 'Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.' else exec_blocked_note(v_row.exec_class) end";
    const applyBefore = norm(fn(read(LAUNCH_UNDONE), "apply_exec_failure_verdict"));
    expect(applyBefore.split(note)).toHaveLength(2);
    expect(norm(fn(later, "apply_exec_failure_verdict"))).toBe(
      applyBefore.replace(
        note,
        "case v_row.exec_result->>'code' when 'chatgpt_ads_launch_undone' then 'Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.' when 'linkedin_ads_post_author_refused' then 'LinkedIn will not run this post as an ad for this account, so Zavi closed the card. Start a new campaign with a post from the page this ad account advertises for.' when 'linkedin_ads_account_changed' then 'The ad account, its company page or its currency changed after you reviewed this campaign, so Zavi closed the card. Start a new campaign and review it again.' else exec_blocked_note(v_row.exec_class) end",
      ),
    );
    expect(later).toContain("revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;");
    expect(later).toContain("revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;");
  });

  it("the launch-undone redefinitions are the prior definitions plus the named edit and nothing else", () => {
    const later = read(LAUNCH_UNDONE);
    const row = "('reddit_ads_retained_object_archived', 'needs_founder', null)";
    const before = norm(fn(read(TERMS_CODE), "classify_exec_failure"));
    expect(before.split(row)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(before.replace(row, `${row}, ('chatgpt_ads_launch_undone', 'blocked_on_us', null)`));
    const note = "v_note := case when v_close then exec_blocked_note(v_row.exec_class) end;";
    const applyBefore = norm(fn(read(AUDIENCE_TERMS), "apply_exec_failure_verdict"));
    expect(applyBefore.split(note)).toHaveLength(2);
    expect(norm(fn(later, "apply_exec_failure_verdict"))).toBe(
      applyBefore.replace(
        note,
        "v_note := case when v_close then case when v_row.exec_result->>'code' = 'chatgpt_ads_launch_undone' then 'Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.' else exec_blocked_note(v_row.exec_class) end end;",
      ),
    );
    expect(later).toContain("revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;");
  });

  it("the email content codes redefinition is the prior definition plus its two rows and nothing else", () => {
    const row = "('email_tool_refused', 'temporary', null)";
    const before = norm(fn(read(CODE_GROUPS), "classify_exec_failure"));
    expect(before.split(row)).toHaveLength(2);
    expect(norm(fn(read(CONTENT_CODES), "classify_exec_failure"))).toBe(
      before.replace(row, `${row}, ('email_content_changed', 'temporary', null), ('email_content_unverifiable', 'temporary', null)`),
    );
  });

  it("the email send redefinitions are the prior definitions plus the named rows and nothing else", () => {
    const later = read(EMAIL_SEND);
    const row = "('google_ads_mutate_incomplete', 'partial_risk', null)";
    const before = norm(fn(read(META_READINESS), "classify_exec_failure"));
    expect(before.split(row)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(before.replace(row, `${row}, ` +
      "('email_tool_not_connected', 'needs_founder', 'reconnect'), " +
      "('email_audience_missing', 'temporary', null), " +
      "('email_tool_refused', 'temporary', null)"));
    const label = "when 'creator' then 'Creator hire'";
    const noteBefore = norm(fn(read("20261016170000_linkedin_ads_write_rail.sql"), "exec_blocked_note"));
    expect(noteBefore.split(label)).toHaveLength(2);
    expect(norm(fn(later, "exec_blocked_note"))).toBe(noteBefore.replace(label, `${label} when 'email_campaign' then 'Mailchimp or Klaviyo'`));
    expect(norm(later)).not.toMatch(/security invoker|grant execute on function [^;]* to [^;]*(authenticated|anon)/);
  });

  it("the pull request card redefinitions are the prior definitions plus the named rows and nothing else", () => {
    const later = read(SEO_PR);
    const row = "('email_tool_refused', 'temporary', null)";
    const before = norm(fn(read(AD_BUDGET_FIX), "classify_exec_failure"));
    expect(before.split(row)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(before.replace(row, `${row}, ('github_not_connected', 'needs_founder', 'reconnect')`));
    const label = "when 'email_campaign' then 'Mailchimp or Klaviyo'";
    const noteBefore = norm(fn(read(EMAIL_SEND), "exec_blocked_note"));
    expect(noteBefore.split(label)).toHaveLength(2);
    expect(norm(fn(later, "exec_blocked_note"))).toBe(noteBefore.replace(label, `${label} when 'seo' then 'GitHub' when 'geo' then 'GitHub'`));
    expect(definers("apply_exec_failure_verdict")).not.toContain(SEO_PR);
    expect(norm(later)).not.toMatch(/security invoker|grant execute on function [^;]* to [^;]*(authenticated|anon)/);
  });

  it("the SendGrid note redefinition only renames the email_campaign label", () => {
    const old = "when 'email_campaign' then 'Mailchimp or Klaviyo'";
    const noteBefore = norm(fn(read(SEO_PR), "exec_blocked_note"));
    expect(noteBefore.split(old)).toHaveLength(2);
    expect(norm(fn(read(SENDGRID_NOTE), "exec_blocked_note"))).toBe(noteBefore.replace(old, "when 'email_campaign' then 'Mailchimp, Klaviyo or SendGrid'"));
    expect(norm(read(SENDGRID_NOTE))).not.toMatch(/security definer|grant execute/);
  });

  it("the Custom Audience terms redefinitions are the prior definitions plus the #2663 branch and fix, nothing else", () => {
    const later = read(AUDIENCE_TERMS);
    const branch = "elsif v_num = 10 or v_num between 200 and 299 then return jsonb_build_object('bucket', 'needs_founder', 'fix', 'permission', 'platform_code', v_meta);";
    const prior = norm(fn(read(CONTENT_CODES), "classify_exec_failure"));
    expect(prior.split(branch)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(prior.replace(branch,
      `${branch} elsif v_num = 2663 then return jsonb_build_object('bucket', 'needs_founder', 'fix', 'audience_terms', 'platform_code', v_meta);`));
    const fixes = "'page_grant', 'page', 'ad_budget')";
    expect(norm(fn(later, "apply_exec_failure_verdict"))).toBe(
      norm(fn(read(ALERT_PER_CODE), "apply_exec_failure_verdict")).replace(fixes, "'page_grant', 'page', 'ad_budget', 'audience_terms')"));
    expect(norm(later)).toContain("revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;");
    expect(norm(later)).not.toMatch(/grant execute|security invoker/);
  });

  it("the Meta readiness redefinitions are the prior definitions plus the named edit and nothing else", () => {
    const later = read(META_READINESS);
    const row = "('meta_ads_permission_revoked', 'needs_founder', 'permission'),";
    expect(norm(fn(later, "classify_exec_failure"))).toBe(norm(fn(sql, "classify_exec_failure")).replace(row, `${row} ` +
      "('meta_ads_connector_missing', 'needs_founder', 'reconnect'), " +
      "('meta_ads_account_not_writable', 'needs_founder', 'permission'), " +
      "('meta_ads_page_permission_missing', 'needs_founder', 'page_grant'), " +
      "('meta_ads_no_page', 'needs_founder', 'page'), " +
      "('meta_ads_page_required', 'needs_founder', 'page'),"));
    const fixes = "'reconnect', 'permission', 'billing', 'credits', 'plan'";
    expect(norm(fn(later, "apply_exec_failure_verdict"))).toBe(
      norm(fn(sql, "apply_exec_failure_verdict")).replace(fixes, `${fixes}, 'page_grant', 'page'`));
    expect(norm(later)).not.toMatch(/grant execute|security invoker/);
  });

  it("the ad budget redefinitions are the prior definitions plus the named edit and nothing else", () => {
    const later = read(AD_BUDGET_FIX);
    const rule = `if v_text ~ '"status":\\s*"UNAUTHENTICATED"|authenticationError|invalid_grant' then`;
    const priorClassify = norm(fn(read(EMAIL_SEND), "classify_exec_failure"));
    expect(priorClassify).toContain(rule);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(priorClassify.replace(rule,
      "if v_text ~ 'cap_refuse: ad_budget_(over_month|over_daily_limit)\\y' then v_bucket := 'needs_founder'; v_fix := 'ad_budget'; " +
      `els${rule}`));
    const fixes = "'plan', 'page_grant', 'page')";
    expect(norm(fn(later, "apply_exec_failure_verdict"))).toBe(
      norm(fn(read(META_READINESS), "apply_exec_failure_verdict")).replace(fixes, "'plan', 'page_grant', 'page', 'ad_budget')"));
    expect(norm(later)).not.toMatch(/grant execute|security invoker/);
  });

  it("the Reddit code redefinition is the prior definition plus the two Reddit rows and nothing else", () => {
    const later = read(REDDIT_CODES);
    const row = "('github_not_connected', 'needs_founder', 'reconnect')";
    const prior = norm(fn(read(SEO_PR), "classify_exec_failure"));
    expect(prior.split(row)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(prior.replace(row, `${row}, ` +
      "('reddit_ads_invalid_request', 'needs_founder', null), " +
      "('reddit_ads_retained_object_archived', 'needs_founder', null)"));
    expect(norm(later)).not.toMatch(/grant execute|security invoker/);
  });

  it("the per-code alert redefinitions are the prior definitions plus the named edits and nothing else", () => {
    const later = read(ALERT_PER_CODE);
    const row = "('meta_ads_page_required', 'needs_founder', 'page')";
    const prior = norm(fn(read(REDDIT_CODES), "classify_exec_failure"));
    expect(prior.split(row)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(prior.replace(row, `${row}, ('meta_ads_bid_unavailable', 'blocked_on_us', null)`));
    const before = norm(fn(read(AD_BUDGET_FIX), "apply_exec_failure_verdict"));
    const after = norm(fn(later, "apply_exec_failure_verdict"));
    const perCard = before.slice(before.indexOf("perform enqueue_ops_alert("), before.indexOf("end if; return jsonb_build_object('stamped'"));
    expect(perCard).toContain("coalesce(v_pcode, 'none')");
    const head = before.slice(0, before.indexOf("perform enqueue_ops_alert("));
    expect(after.startsWith(head.replace("v_close boolean; begin", "v_close boolean; v_prefix text; begin"))).toBe(true);
    expect(after.endsWith("end if; end if; return jsonb_build_object('stamped', true, 'closed', v_close, 'bucket', v_bucket); end $$;")).toBe(true);
    expect(after).toContain("if v_pcode is null then perform enqueue_ops_alert( 'blocked:' || p_action_id,");
    expect(after).toContain("if v_bucket = 'blocked_on_us' and v_pcode is not null then");
    expect(norm(later)).toContain("revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;");
    expect(norm(later)).not.toMatch(/grant execute|security invoker/);
  });

  it("the code-groups redefinition is the prior definition plus the one return and nothing else", () => {
    const later = read(CODE_GROUPS);
    const ret = "if v_bucket is not null then return jsonb_build_object('bucket', v_bucket, 'fix', v_fix, 'platform_code', null); end if;";
    const prior = norm(fn(read(ALERT_PER_CODE), "classify_exec_failure"));
    expect(prior.split(ret)).toHaveLength(2);
    expect(norm(fn(later, "classify_exec_failure"))).toBe(prior.replace(ret,
      "if v_bucket is not null then return jsonb_build_object('bucket', v_bucket, 'fix', v_fix, 'platform_code', case when v_bucket = 'blocked_on_us' then v_code end); end if;"));
    expect(norm(later)).not.toMatch(/grant execute|security invoker/);
  });

  it("exec_blocked_note's redefinition is the prior definition plus the LinkedIn label and nothing else", () => {
    const before = norm(fn(sql, "exec_blocked_note"));
    const after = norm(fn(read("20261016170000_linkedin_ads_write_rail.sql"), "exec_blocked_note"));
    expect(after).toBe(before.replace(
      "when 'google_ads' then 'Google Ads'",
      "when 'google_ads' then 'Google Ads' when 'linkedin_ads' then 'LinkedIn Ads'",
    ));
    expect(after).not.toBe(before);
  });

  it("settle: the failure branch only adds the verdict call; everything else verbatim", () => {
    const before = norm(fn(read("20260928220000_settle_channel_action_exec_cgo_actor.sql"), "settle_channel_action_exec"));
    const after = norm(fn(sql, "settle_channel_action_exec"));
    const anchor = "(p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key); end if;";
    expect(before.split(anchor)).toHaveLength(2);
    expect(after).toBe(before.replace(anchor,
      "(p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key); perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_result); end if;"));
  });

  it("video settle: a trailing p_verdict, the same verdict call, the old 8-arg overload dropped; everything else verbatim", () => {
    expect(norm(sql)).toContain("drop function if exists set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text);");
    expect(sql.indexOf("drop function if exists set_channel_action_video_media")).toBeLessThan(sql.indexOf("create or replace function set_channel_action_video_media("));
    const before = norm(fn(read("20260930080300_set_channel_action_video_media.sql"), "set_channel_action_video_media"));
    const after = norm(fn(sql, "set_channel_action_video_media"));
    const expected = before
      .replace("p_code text default null )", "p_code text default null, p_verdict jsonb default null )")
      .replace("(p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key); end if;",
        "(p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key); perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_verdict); end if;");
    expect(expected).not.toBe(before);
    expect(after).toBe(expected);
  });

  it("the verdict helper: locks the row, stamps only a failed row, closes only an OPEN blocked card, one event and one alert keyed per card", () => {
    const body = norm(fn(sql, "apply_exec_failure_verdict"));
    for (const c of [
      "where id = p_action_id and tenant_id = p_tenant_id for update;",
      "if not found or v_row.exec_status is distinct from 'failed' then",
      "if coalesce(v_v->>'bucket', '') not in ('blocked_on_us', 'needs_founder', 'temporary', 'partial_risk') then v_v := classify_exec_failure(v_row.exec_result);",
      "and v_v->>'fix' in ('reconnect', 'permission', 'billing', 'credits', 'plan')",
      "v_close := v_bucket = 'blocked_on_us' and v_row.status in ('pending', 'snoozed');",
      "|| jsonb_build_object('bucket', v_bucket, 'fix', v_fix, 'platform_code', v_pcode)",
      "status = case when v_close then 'stale' else status end",
      "'stale_flagged', 'system'",
      "'blocked:' || p_action_id) on conflict (action_id, event_key) do nothing;",
      "perform enqueue_ops_alert( 'blocked:' || p_action_id,",
    ]) expect(body, c).toContain(c);
    expect(body).not.toMatch(/status = 'pending'|then 'pending'/);
    expect(norm(sql)).toContain("revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;");
    expect(norm(sql)).not.toMatch(/grant execute on function apply_exec_failure_verdict/);
  });

  it("the outbox: unique key, due index, RLS on with no policy, a claim with skip locked and an attempt fencing token", () => {
    const s = norm(sql);
    expect(s).toContain("dedupe_key text not null unique");
    expect(s).toContain("create index if not exists ops_alert_outbox_due_idx on ops_alert_outbox (next_attempt_at) where status in ('pending', 'sending');");
    expect(s).toContain("alter table ops_alert_outbox enable row level security;");
    expect(s).not.toMatch(/create policy [^;]* on ops_alert_outbox/);
    expect(norm(fn(sql, "claim_ops_alerts"))).toContain("for update skip locked");
    expect(norm(fn(sql, "finish_ops_alert"))).toContain("where id = p_id and status = 'sending' and attempts = p_attempt;");
    expect(norm(fn(sql, "enqueue_ops_alert"))).toContain("on conflict (dedupe_key) do nothing");
  });

  it("the re-classification doors: a partial index for the page, replay unless forced", () => {
    expect(norm(sql)).toContain("create index if not exists channel_actions_failed_open_idx on channel_actions (id) where exec_status = 'failed' and status in ('pending', 'snoozed');");
    const list = norm(fn(sql, "list_failed_open_channel_actions"));
    expect(list).toContain("where a.exec_status = 'failed' and a.status in ('pending', 'snoozed') and (p_after is null or a.id > p_after) order by a.id limit least(greatest(coalesce(p_limit, 200), 1), 500);");
    const stamp = norm(fn(sql, "stamp_channel_action_exec_verdict"));
    expect(stamp).toContain("select * into v_row from channel_actions where id = p_action_id for update;");
    expect(stamp).toContain("if not found or v_row.tenant_id is distinct from p_tenant_id then return jsonb_build_object('ok', false, 'code', 'not_found');");
    expect(stamp).toContain("if not coalesce(p_force, false)");
  });

  it("the legacy stamp runs in this migration, over every failed row without a verdict", () => {
    const tail = norm(sql.slice(sql.lastIndexOf("do $$")));
    expect(tail).toContain("where a.exec_status = 'failed' and not (jsonb_typeof(a.exec_result) = 'object' and a.exec_result ? 'bucket')");
    expect(tail).toContain("v_out := apply_exec_failure_verdict(r.tenant_id, r.id, r.run_id, null);");
    expect(sql.lastIndexOf("do $$")).toBeGreaterThan(sql.indexOf("create or replace function apply_exec_failure_verdict("));
  });

  it("every function: pinned search_path; definers are security definer; callable ones service-role only", () => {
    for (const name of ["apply_exec_failure_verdict", "settle_channel_action_exec", "set_channel_action_video_media", "stamp_channel_action_exec_verdict",
      "list_failed_open_channel_actions", "enqueue_ops_alert", "claim_ops_alerts", "finish_ops_alert"]) {
      expect(norm(fn(sql, name)), name).toMatch(/security definer set search_path = public, pg_temp as \$\$/);
    }
    for (const name of ["classify_exec_failure", "exec_blocked_note"]) {
      expect(norm(fn(sql, name)), name).toMatch(/immutable set search_path = public, pg_temp as \$\$/);
      expect(norm(fn(sql, name)), name).not.toContain("security definer");
    }
    for (const sig of [
      "settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)",
      "set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text, jsonb)",
      "stamp_channel_action_exec_verdict(uuid, uuid, jsonb, boolean)",
      "list_failed_open_channel_actions(uuid, int)",
      "enqueue_ops_alert(text, text, text, uuid, text)",
      "claim_ops_alerts(int)",
      "finish_ops_alert(bigint, int, boolean, text)",
      "classify_exec_failure(jsonb)",
      "exec_blocked_note(text)",
    ]) {
      expect(norm(sql), sig).toContain(norm(`revoke all on function ${sig} from public, anon, authenticated;`));
      expect(norm(sql), sig).toContain(norm(`grant execute on function ${sig} to service_role;`));
    }
    expect(norm(sql)).not.toMatch(/grant execute on function [^;]* to [^;]*(authenticated|anon)/);
  });
});
