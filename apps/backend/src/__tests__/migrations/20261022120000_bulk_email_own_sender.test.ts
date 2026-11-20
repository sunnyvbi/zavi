import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261022120000_bulk_email_own_sender.sql"), "utf-8");

const TABLES = [
  "email_bulk_abuse_holds",
  "email_contacts",
  "email_lists",
  "email_list_versions",
  "email_list_version_contacts",
  "email_bulk_sends",
  "email_bulk_send_recipients",
];

const DEFINER_RPCS = [
  "email_bulk_block_reason",
  "email_list_import_version",
  "email_list_record_consent",
  "email_list_summaries",
  "email_list_contacts_page",
  "email_list_version_emails",
  "email_contact_erase",
  "email_bulk_freeze_send",
  "email_bulk_claim_next",
  "email_bulk_settle_recipient",
  "email_bulk_mark_stale_unknown",
  "email_bulk_settle_send",
  "email_bulk_record_feedback",
  "tenant_sending_domain_upsert_pending",
  "tenant_sending_domain_set_status",
  "email_bulk_skip_if_blocked",
  "tenant_sending_domain_check",
  "tenant_sending_domain_release",
  "email_bulk_clear_abuse_hold",
  "email_bulk_resume_send",
  "email_bulk_requeue_claimed",
  "email_bulk_abuse_switch_off",
];

function fn(name: string): string {
  const m = SQL.match(new RegExp(String.raw`create or replace function public\.${name}\([\s\S]*?\n(?:end )?\$\$;`));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
}

describe("bulk email own sender (20261022120000)", () => {
  it.each(TABLES)("%s: RLS on, no policy, nothing granted to public, anon or authenticated", (t) => {
    expect(SQL).toMatch(new RegExp(String.raw`alter table public\.${t} enable row level security;`));
    expect(SQL).toMatch(new RegExp(String.raw`revoke all on public\.${t} from public, anon, authenticated;`));
    expect(SQL).toMatch(new RegExp(String.raw`grant select, insert, update, delete on public\.${t} to service_role;`));
    expect(SQL).not.toMatch(/create policy/i);
  });

  it.each(TABLES)("%s: belongs to a workspace and is removed with it", (t) => {
    const table = SQL.match(new RegExp(String.raw`create table if not exists public\.${t} \([\s\S]*?\n\);`))![0];
    expect(table).toMatch(/tenant_id\s+uuid (not null|primary key) references public\.tenants\(id\) on delete cascade/);
  });

  it("every child points at its parent by (tenant_id, parent id), never by id alone", () => {
    expect(SQL).toMatch(/foreign key \(tenant_id, list_id\)\s+references public\.email_lists \(tenant_id, id\)/);
    expect(SQL).toMatch(/foreign key \(tenant_id, version_id\)\s+references public\.email_list_versions \(tenant_id, id\)/);
    expect(SQL).toMatch(/foreign key \(tenant_id, contact_id\)\s+references public\.email_contacts \(tenant_id, id\)/);
    expect(SQL).toMatch(/foreign key \(tenant_id, send_id\)\s+references public\.email_bulk_sends \(tenant_id, id\)/);
    expect(SQL).toMatch(/foreign key \(tenant_id, decision_id\)\s+references public\.decisions \(tenant_id, id\)/);
    expect(SQL).not.toMatch(/references public\.email_[a-z_]+\s*\(id\)/);
  });

  it("a version must belong to its list: the active version and a send's version use the triple", () => {
    expect(SQL).toMatch(/unique \(tenant_id, list_id, id\)/);
    expect(SQL).toMatch(/foreign key \(tenant_id, id, active_version_id\)\s+references public\.email_list_versions \(tenant_id, list_id, id\)/);
    expect(SQL).toMatch(/foreign key \(tenant_id, list_id, list_version_id\)\s+references public\.email_list_versions \(tenant_id, list_id, id\)/);
  });

  it("list names are unique per workspace among lists that are not archived", () => {
    expect(SQL).toMatch(/create unique index if not exists email_lists_tenant_name_uq\s+on public\.email_lists \(tenant_id, lower\(trim\(name\)\)\) where archived_at is null;/);
  });

  it("a version cannot change after it is created, and consent is recorded once", () => {
    const trg = SQL.match(/create or replace function public\.email_list_versions_immutable\(\)[\s\S]*?\nend \$\$;/)![0];
    expect(trg).toMatch(/new\.contact_count is distinct from old\.contact_count/);
    expect(trg).toMatch(/old\.consent_confirmed_at is not null and/);
    expect(SQL).toMatch(/before update on public\.email_list_versions/);
    const consent = fn("email_list_record_consent");
    expect(consent).toMatch(/and v\.consent_confirmed_at is null;/);
    expect(consent).toMatch(/'already_recorded'/);
    expect(consent).toMatch(/'superseded'/);
    expect(consent).toMatch(/from public\.tenant_users tu/);
  });

  it.each(DEFINER_RPCS)("%s: security definer, search_path pinned with pg_temp, service role only", (name) => {
    const body = fn(name);
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(SQL).toMatch(new RegExp(String.raw`revoke all on function public\.${name}\([^)]*\) from public, anon, authenticated;`));
    expect(SQL).toMatch(new RegExp(String.raw`grant execute on function public\.${name}\([^)]*\) to service_role;`));
    expect(SQL).not.toMatch(new RegExp(String.raw`grant execute on function public\.${name}\([^)]*\) to (anon|authenticated)`));
  });

  it("the do-not-email check reads BOTH existing records", () => {
    const block = fn("email_bulk_block_reason");
    expect(block).toMatch(/from public\.email_suppression s/);
    expect(block).toMatch(/from public\.comms_unsubscribes u/);
    expect(block).toMatch(/from public\.comms_suppressions x/);
  });

  it("freezing a send needs a person's approval, a consented version of that list, and is idempotent on the decision", () => {
    const freeze = fn("email_bulk_freeze_send");
    expect(freeze).toMatch(/d\.decision_class = 'bulk_outbound\.send'/);
    expect(freeze).toMatch(/and d\.approved_by is not null/);
    expect(freeze).toMatch(/v\.id = p_version_id and v\.list_id = p_list_id and v\.tenant_id = p_tenant_id\s+and v\.consent_confirmed_at is not null/);
    expect(freeze).toMatch(/l\.archived_at is null/);
    expect(freeze).toMatch(/on conflict \(decision_id\) do nothing/);
    expect(freeze).toMatch(/v_cap\s+int := least\(coalesce\(p_cap, 0\), 1000\);/);
    expect(freeze).toMatch(/limit v_cap/);
    expect(freeze).not.toMatch(/limit p_cap/);
    expect(freeze).toMatch(/from public\.email_bulk_abuse_holds a\s+where a\.tenant_id = p_tenant_id and a\.cleared_at is null/);
    expect(SQL).toMatch(/constraint email_bulk_sends_decision_key unique \(decision_id\)/);
  });

  it("claiming is one atomic step: skip, allowance, then pending -> sending", () => {
    const claim = fn("email_bulk_claim_next");
    expect(claim).toMatch(/r\.status = 'pending'[\s\S]*for update of r skip locked/);
    expect(claim).not.toMatch(/p_effective_cap|p_day\b/);
    expect(claim).toMatch(/p_daily_cap is null or p_daily_cap < 0/);
    expect(claim).toMatch(/v_day\s+date := \(now\(\) at time zone 'utc'\)::date;/);
    expect(claim).not.toMatch(/touch_domain_warmup\(/);
    expect(claim).toMatch(/v_warmup := case when v_day_index >= 10 then 0 else 50 \* \(2 \^ greatest\(v_day_index, 0\)\)::int end;/);
    expect(claim).toMatch(/when v_warmup > 0 and p_daily_cap > 0 then least\(v_warmup, p_daily_cap\)\s+when v_warmup > 0 then v_warmup/);
    expect(claim).toMatch(/and \(v_cap = 0 or sent_count \+ 1 <= v_cap\)/);
    expect(claim).toMatch(/from public\.email_bulk_abuse_holds a\s+where a\.tenant_id = p_tenant_id and a\.cleared_at is null/);
    expect(claim).toMatch(/'allowance_exhausted'/);
    expect(claim).toMatch(/public\.email_bulk_block_reason\(p_tenant_id, v_email\)/);
    expect(claim).toMatch(/v_status is distinct from 'sending'/);
    expect(claim.indexOf("sent_count + 1")).toBeLessThan(claim.indexOf("set status = 'sending'"));
  });

  it("only a definitely-refused claim goes back to pending; unknown never does", () => {
    const pendingWriters = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\([\s\S]*?\n(?:end )?\$\$;/g)]
      .filter((m) => /set status = 'pending'/.test(m[0]))
      .map((m) => m[1]);
    expect(pendingWriters).toEqual(["email_bulk_requeue_claimed"]);
    expect(fn("email_bulk_requeue_claimed")).toMatch(/set status = 'pending'[\s\S]*and r\.status = 'sending';/);
    expect(fn("email_bulk_settle_recipient")).toMatch(/p_status not in \('sent', 'failed', 'unknown'\)/);
    expect(fn("email_bulk_mark_stale_unknown")).toMatch(/set status = 'unknown'[\s\S]*r\.status = 'sending'/);
  });

  it("no status write can release a hold or reopen a finished send", () => {
    const settle = fn("email_bulk_settle_send");
    expect(settle).toMatch(/when s\.status in \('done', 'failed'\) then s\.status/);
    expect(settle).toMatch(/when s\.status = 'held' then s\.status/);
  });

  it("erasing a contact leaves a do-not-email row, skips waiting emails and removes the address, in one function", () => {
    const erase = fn("email_contact_erase");
    expect(erase).toMatch(/insert into public\.email_suppression \(tenant_id, email, reason\)\s+values \(p_tenant_id, v_email, 'erased'\)\s+on conflict \(tenant_id, email\) do nothing;/);
    expect(erase).toMatch(/set status = 'skipped', skip_reason = 'erased'[\s\S]*r\.status in \('pending', 'sending'\)/);
    expect(erase).toMatch(/set erased_at = now\(\), email_norm = null/);
    expect(erase).not.toMatch(/delete from public\.email_suppression/);
    expect(SQL).toMatch(/check \(reason in \('unsubscribe', 'bounce', 'complaint', 'manual', 'erased'\)\)/);
  });

  it("the abuse counter counts a recipient once and holds the send when a rate is crossed", () => {
    const fb = fn("email_bulk_record_feedback");
    expect(fb).toMatch(/and r\.feedback is null;/);
    expect(fb).not.toMatch(/p_min_sent|p_complaint_rate|p_bounce_rate/);
    expect(fb).toMatch(/c_complaints_any constant int := 5;/);
    expect(fb).toMatch(/c_min_sent\s+constant int := 200;/);
    expect(fb).toMatch(/if v\.complaints >= c_complaints_any then[\s\S]*elsif v_sent >= c_min_sent then/);
    expect(fb).toMatch(/c_complaint_rate constant numeric := 0\.003;/);
    expect(fb).toMatch(/c_bounce_rate\s+constant numeric := 0\.05;/);
    expect(fb).toMatch(/v_sent >= c_min_sent/);
    expect(fb).toMatch(/set status = 'held', hold_reason = v_reason/);
    expect(fb).toMatch(/insert into public\.email_bulk_abuse_holds \(tenant_id, send_id, reason\)/);
    expect(fn("email_bulk_settle_send")).toMatch(/insert into public\.email_bulk_abuse_holds \(tenant_id, send_id, reason\)/);
  });

  it("a provider answer is written only for the record AND the domain it was about", () => {
    expect(fn("tenant_sending_domain_set_status")).toMatch(/d\.provider_domain_id = p_provider_domain_id\s+and lower\(d\.domain\) = lower\(trim\(p_domain\)\)/);
  });

  it("a list name has no control characters, so it cannot add a fake line to a card", () => {
    expect(SQL).toMatch(/name !~ '\[\[:cntrl:\]\]'/);
  });

  it("only the approved text is stored for a send: no separate HTML body", () => {
    const sends = SQL.match(/create table if not exists public\.email_bulk_sends \([\s\S]*?\n\);/)![0];
    expect(sends).not.toMatch(/body_html/);
    expect(sends).toMatch(/reply_to\s+text,/);
  });

  it("only an owner or admin can add a sending domain, and nobody can claim another workspace's", () => {
    const up = fn("tenant_sending_domain_upsert_pending");
    expect(up).toMatch(/tu\.role in \('owner', 'admin'\)/);
    expect(up).toMatch(/lower\(d\.domain\) = lower\(trim\(p_domain\)\) and d\.tenant_id <> p_tenant_id/);
    expect(up).toMatch(/verification_status = 'pending'/);
    expect(up).not.toMatch(/verification_status = 'verified'|'verified',/);
  });

  it("review round 1: claim locks the send row and advances the warm-up only when someone is claimed", () => {
    const claim = fn("email_bulk_claim_next");
    expect(claim).toMatch(/from public\.email_bulk_sends s\s+where s\.id = p_send_id and s\.tenant_id = p_tenant_id\s+for update;/);
    expect(claim).toMatch(/from public\.email_domain_warmup w[\s\S]*for update;/);
    const settle = fn("email_bulk_settle_recipient");
    expect(settle).toMatch(/if v_n > 0 and p_status in \('sent', 'unknown'\) then[\s\S]*perform public\.touch_domain_warmup\(/);
    expect(fn("email_bulk_requeue_claimed")).not.toMatch(/touch_domain_warmup/);
  });

  it("review round 1: a person blocked or erased after the claim is not sent; erase covers claimed rows", () => {
    const skip = fn("email_bulk_skip_if_blocked");
    expect(skip).toMatch(/for update of r/);
    expect(skip).toMatch(/if v_status = 'skipped' then/);
    expect(skip).toMatch(/public\.email_bulk_block_reason\(p_tenant_id, v_email\)/);
    expect(fn("email_contact_erase")).toMatch(/r\.status in \('pending', 'sending'\)/);
    expect(fn("email_bulk_settle_recipient")).toMatch(/r\.status = 'skipped' and r\.skip_reason = 'erased'/);
  });

  it("review round 1: a domain pending over 7 days is released; verified ones never", () => {
    for (const name of ["tenant_sending_domain_check", "tenant_sending_domain_release"]) {
      expect(fn(name)).toMatch(/tu\.role in \('owner', 'admin'\)/);
    }
    expect(fn("tenant_sending_domain_check")).toMatch(/d\.verification_status <> 'verified' and d\.updated_at < now\(\) - interval '7 days'/);
    expect(fn("tenant_sending_domain_release")).toMatch(/not p_only_stale\s+or \(d\.verification_status <> 'verified' and d\.updated_at < now\(\) - interval '7 days'\)/);
    expect(fn("tenant_sending_domain_upsert_pending")).toMatch(/or p_provider_domain_id is null then/);
  });

  it("review round 1: only the staff resume function moves a send out of held, and never while on abuse hold", () => {
    const resume = fn("email_bulk_resume_send");
    expect(resume).toMatch(/if v\.status <> 'held' then/);
    expect(resume).toMatch(/from public\.email_bulk_abuse_holds a\s+where a\.tenant_id = p_tenant_id and a\.cleared_at is null/);
    expect(resume).toMatch(/set status = 'sending', hold_reason = null/);
    expect(resume).not.toMatch(/update public\.email_bulk_send_recipients/);
    const releasers = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\([\s\S]*?\n(?:end )?\$\$;/g)]
      .filter((m) => /update public\.email_bulk_sends s\s+set status = 'sending'/.test(m[0]))
      .map((m) => m[1]);
    expect(releasers).toEqual(["email_bulk_resume_send"]);
    expect(fn("email_bulk_clear_abuse_hold")).toMatch(/set cleared_at = now\(\), cleared_by = p_staff_user_id/);
  });

  it("security round 2: resume only for holds staff can clear, with the send's preconditions re-checked inside", () => {
    const resume = fn("email_bulk_resume_send");
    expect(resume).toMatch(/not in \('abuse_complaints', 'abuse_bounces', 'provider_refused', 'bulk_check_failed'\)/);
    expect(resume).toMatch(/t\.key = 'bulk_outbound_enabled'[\s\S]*v_flag = 'false'::jsonb/);
    expect(resume).toMatch(/bulk_email_send_enabled' = 'false'::jsonb/);
    expect(resume).toMatch(/d\.verification_status = 'verified'\s+and lower\(d\.domain\) = v_domain/);
    expect(resume).toMatch(/l\.archived_at is null/);
    expect(resume).toMatch(/lv\.consent_confirmed_at is not null/);
  });

  it("security round 2: clearing a hold needs ACTIVE staff and re-enables only the false the shutoff wrote", () => {
    const clear = fn("email_bulk_clear_abuse_hold");
    expect(clear).toMatch(/su\.user_id = p_staff_user_id and su\.revoked_at is null/);
    expect(clear).toMatch(/t\.value = 'false'::jsonb and t\.updated_by = 'system:bulk-email-abuse-shutoff'/);
    expect(clear).toMatch(/delete from public\.tenant_app_setting t\s+where t\.tenant_id = p_tenant_id and t\.key = 'bulk_outbound_enabled'/);
    expect(clear).not.toMatch(/'true'::jsonb/);
  });

  it("security round 2: a stale claim is released only inside the new claim's transaction, and only if unverified and untouched for 7 days", () => {
    expect(fn("tenant_sending_domain_check")).not.toMatch(/delete from/);
    const up = fn("tenant_sending_domain_upsert_pending");
    expect(up).toMatch(/delete from public\.tenant_sending_domain d\s+where lower\(d\.domain\) = lower\(trim\(p_domain\)\) and d\.tenant_id <> p_tenant_id\s+and d\.verification_status <> 'verified' and d\.updated_at < now\(\) - interval '7 days'/);
    expect(up.indexOf("delete from public.tenant_sending_domain")).toBeLessThan(up.indexOf("insert into public.tenant_sending_domain"));
    expect(up).toMatch(/'released_provider_domain_id', v_released/);
  });

  it("review round 2: a redelivered feedback event returns before any threshold, so it cannot reopen a cleared hold", () => {
    const fb = fn("email_bulk_record_feedback");
    const early = fb.indexOf("if v_n = 0 then");
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(fb.indexOf("c_complaints_any then"));
    expect(early).toBeLessThan(fb.indexOf("insert into public.email_bulk_abuse_holds"));
    expect(fb.slice(early, early + 200)).toMatch(/'counted', false, 'tripped', false/);
  });

  it("review round 2: the shutoff switch-off is one conditional write that never overwrites an existing false or its author", () => {
    const off = fn("email_bulk_abuse_switch_off");
    expect(off).toMatch(/on conflict \(tenant_id, key\) do update[\s\S]*where t\.value is distinct from 'false'::jsonb;/);
    expect(off).toMatch(/'system:bulk-email-abuse-shutoff'/);
    expect(fn("email_bulk_clear_abuse_hold")).toMatch(/t\.updated_by = 'system:bulk-email-abuse-shutoff'/);
  });

  it("consent round: nobody is claimed from an archived list or a version whose consent is not on record", () => {
    const claim = fn("email_bulk_claim_next");
    expect(claim).toMatch(/l\.archived_at is null and lv\.consent_confirmed_at is not null/);
    expect(claim.indexOf("lv.consent_confirmed_at is not null")).toBeLessThan(claim.indexOf("for update of r skip locked"));
    expect(fn("email_bulk_requeue_claimed")).not.toMatch(/set status = 'sending'|'sent'/);
  });
});
