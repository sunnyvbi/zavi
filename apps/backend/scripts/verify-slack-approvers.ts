
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const UPCAR_AI_TENANT_ID = "73db45ff-457e-4541-bc8f-bdb625390204";

export const UPCAR_ROSTER = [
  "Jemis",
  "Mohit",
  "Jignesh",
  "Jay",
  "Suresh",
  "Hemachandran",
  "Abhishek",
  "Ritesh",
] as const;

export type ApproverChecks = {
  activeTeamMember: boolean;
  slackIdentity: boolean;
  tenantAuthMember: boolean;
};

export type ApproverResult = {
  name: string;
  checks: ApproverChecks;
  note?: string;
};

export function classifyRow(r: ApproverResult): "PASS" | "FAIL" {
  return r.checks.activeTeamMember && r.checks.slackIdentity && r.checks.tenantAuthMember
    ? "PASS"
    : "FAIL";
}

export function failReason(r: ApproverResult): string {
  if (!r.checks.activeTeamMember) return "no active team_member";
  if (!r.checks.slackIdentity) return "no slack identity";
  if (!r.checks.tenantAuthMember) return "not a tenant_users auth member";
  return "";
}

function check(b: boolean): string {
  return b ? "yes" : "no ";
}

export function renderTable(results: ApproverResult[]): string {
  const header =
    "PERSON         | active member | slack id | auth member | RESULT | reason";
  const sep =
    "---------------+---------------+----------+-------------+--------+-------------------------";
  const lines = results.map((r) => {
    const verdict = classifyRow(r);
    const reason = verdict === "FAIL" ? failReason(r) : r.note ? r.note : "";
    return [
      r.name.padEnd(14),
      check(r.checks.activeTeamMember).padEnd(13),
      check(r.checks.slackIdentity).padEnd(8),
      check(r.checks.tenantAuthMember).padEnd(11),
      verdict.padEnd(6),
      reason,
    ].join(" | ");
  });
  return [header, sep, ...lines].join("\n");
}

export type ApproverSummary = {
  total: number;
  passing: number;
  failing: number;
  allPass: boolean;
};

export function summarize(results: ApproverResult[]): ApproverSummary {
  const passing = results.filter((r) => classifyRow(r) === "PASS").length;
  return {
    total: results.length,
    passing,
    failing: results.length - passing,
    allPass: results.length > 0 && passing === results.length,
  };
}

async function resolveOne(
  sc: SupabaseClient,
  tenantId: string,
  name: string,
  authEmails: Set<string>,
): Promise<ApproverResult> {
  const checks: ApproverChecks = {
    activeTeamMember: false,
    slackIdentity: false,
    tenantAuthMember: false,
  };
  let note: string | undefined;

  const { data: members, error: mErr } = await sc
    .from("team_members")
    .select("id, display_name, primary_email")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .ilike("display_name", `%${name}%`);
  if (mErr) {
    note = `team_members read error: ${mErr.message}`;
    return { name, checks, note };
  }
  const matches = members ?? [];
  if (matches.length === 0) {
    return { name, checks, note };
  }
  if (matches.length > 1) {
    note = `ambiguous: ${matches.length} active members match`;
  }
  const member = matches[0] as { id: string; display_name: string; primary_email: string | null };
  checks.activeTeamMember = true;

  const { data: ids, error: iErr } = await sc
    .from("team_member_identities")
    .select("external_id")
    .eq("tenant_id", tenantId)
    .eq("member_id", member.id)
    .eq("provider", "slack");
  if (iErr) {
    note = `${note ? note + "; " : ""}identities read error: ${iErr.message}`;
  } else {
    checks.slackIdentity = (ids ?? []).some((x) => (x as { external_id?: string }).external_id);
  }

  const email = member.primary_email ? member.primary_email.toLowerCase() : null;
  if (!email) {
    note = `${note ? note + "; " : ""}member has no primary_email`;
  } else {
    checks.tenantAuthMember = authEmails.has(email);
  }

  return { name, checks, note };
}

async function loadTenantAuthEmails(
  sc: SupabaseClient,
  tenantId: string,
): Promise<Set<string>> {
  const { data: tu, error: tuErr } = await sc
    .from("tenant_users")
    .select("user_id, role")
    .eq("tenant_id", tenantId);
  if (tuErr) throw new Error(`tenant_users read failed: ${tuErr.message}`);
  const memberUserIds = new Set(
    (tu ?? [])
      .map((r) => r as { user_id: string; role: string | null })
      .filter((r) => r.role !== "viewer")
      .map((r) => r.user_id),
  );

  const emails = new Set<string>();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await sc.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`auth.admin.listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.id && u.email && memberUserIds.has(u.id)) {
        emails.add(u.email.toLowerCase());
      }
    }
    if (users.length < perPage) break;
    page += 1;
  }
  return emails;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) {
    console.error("missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (load apps/backend/.env)");
    process.exit(1);
  }
  const tenantId = process.env.VERIFY_TENANT_ID || UPCAR_AI_TENANT_ID;

  const sc = createClient(url, svc, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`[verify-slack-approvers] tenant=${tenantId} (read-only)\n`);

  const authEmails = await loadTenantAuthEmails(sc, tenantId);
  const results: ApproverResult[] = [];
  for (const name of UPCAR_ROSTER) {
    results.push(await resolveOne(sc, tenantId, name, authEmails));
  }

  console.log(renderTable(results));
  const s = summarize(results);
  console.log(
    `\n${s.passing}/${s.total} pass resolve_slack_approver — ${
      s.allPass
        ? "all roster humans CAN be Slack-form approvers for this tenant."
        : "some roster humans need the staff-only fallback (contract #4 D0)."
    }`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
