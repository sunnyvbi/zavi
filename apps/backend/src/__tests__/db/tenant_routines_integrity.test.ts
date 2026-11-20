
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HAS_ALL = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE);

const PROD_PROJECT_HOST = "wmycgyjsenvgtczlupoe.supabase.co";
const IS_PROD = !!SUPA_URL && SUPA_URL.includes(PROD_PROJECT_HOST);
if (IS_PROD) {
  // eslint-disable-next-line no-console
  console.warn(
    `[tenant_routines_integrity] refusing to run against prod (${PROD_PROJECT_HOST}). ` +
      `Skipping suite. Point SUPABASE_URL at a local or test project.`,
  );
}

const SHOULD_RUN = HAS_ALL && !IS_PROD;

function svc(): SupabaseClient {
  return createClient(SUPA_URL!, SUPA_SERVICE!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function clientWithJwt(jwt: string): SupabaseClient {
  return createClient(SUPA_URL!, SUPA_ANON!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

async function signUpAndSignIn(
  sb: SupabaseClient,
  email: string,
  password: string,
): Promise<{ id: string; jwt: string }> {
  const { data: created, error: cErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (cErr || !created.user) throw new Error(`createUser ${email}: ${cErr?.message}`);
  const anon = createClient(SUPA_URL!, SUPA_ANON!);
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr || !sess.session) throw new Error(`signIn ${email}: ${sErr?.message}`);
  return { id: created.user.id, jwt: sess.session.access_token };
}

async function seedNote(
  sb: SupabaseClient,
  opts: { tenantId: string; agentSlug: string | null; noteType: string },
): Promise<string> {
  const { data, error } = await sb
    .from("memory_note")
    .insert({
      tenant_id: opts.tenantId,
      title: "tenant_routines integrity fixture",
      body_markdown: "fixture note",
      source: "agent_write",
      note_type: opts.noteType,
      agent_slug: opts.agentSlug,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedNote: ${error?.message}`);
  return data.id;
}

describe.skipIf(!SHOULD_RUN)("tenant_routines — live RLS + integrity trigger", () => {
  const AGENT = "engineer";
  const OTHER_AGENT = "support-lead";

  let tenantA = "";
  let tenantB = "";
  let memberAJwt = "";

  let noteA_exp = "";
  let noteB_exp = "";
  let noteA_wrongType = "";
  let noteA_wrongAgent = "";

  beforeAll(async () => {
    const sb = svc();
    const ts = Date.now();

    const { data: tA, error: tAErr } = await sb
      .from("tenants")
      .insert({ slug: `tskills-a-${ts}`, display_name: "TS A" })
      .select("id")
      .single();
    if (tAErr || !tA) throw new Error(`tenant A: ${tAErr?.message}`);
    tenantA = tA.id;

    const { data: tB, error: tBErr } = await sb
      .from("tenants")
      .insert({ slug: `tskills-b-${ts}`, display_name: "TS B" })
      .select("id")
      .single();
    if (tBErr || !tB) throw new Error(`tenant B: ${tBErr?.message}`);
    tenantB = tB.id;

    const pw = "tskills-PW-12345!Aa";
    const memberA = await signUpAndSignIn(sb, `tskills-mem-a-${ts}@zavi.test`, pw);
    memberAJwt = memberA.jwt;
    const { error: tuErr } = await sb
      .from("tenant_users")
      .insert([{ tenant_id: tenantA, user_id: memberA.id, role: "owner" }]);
    if (tuErr) throw new Error(`tenant_users seed: ${tuErr.message}`);

    noteA_exp = await seedNote(sb, {
      tenantId: tenantA,
      agentSlug: AGENT,
      noteType: "agent_experience",
    });
    noteB_exp = await seedNote(sb, {
      tenantId: tenantB,
      agentSlug: AGENT,
      noteType: "agent_experience",
    });
    noteA_wrongType = await seedNote(sb, {
      tenantId: tenantA,
      agentSlug: AGENT,
      noteType: "operator_preference",
    });
    noteA_wrongAgent = await seedNote(sb, {
      tenantId: tenantA,
      agentSlug: OTHER_AGENT,
      noteType: "agent_experience",
    });
  }, 120_000);

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const sb = svc();
    if (tenantA) await sb.from("tenants").delete().eq("id", tenantA);
    if (tenantB) await sb.from("tenants").delete().eq("id", tenantB);
  });

  it("accepts a candidate whose source_note is same-tenant + agent_experience + same-agent", async () => {
    const sb = svc();
    const { data, error } = await sb
      .from("tenant_routines")
      .insert({
        tenant_id: tenantA,
        agent_slug: AGENT,
        source_note_id: noteA_exp,
        routine_name: "happy path routine",
        status: "candidate",
      })
      .select("id")
      .single();
    expect(error, `happy-path insert should succeed: ${error?.message}`).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  it("accepts a candidate with a NULL source_note (trigger is a no-op when unset)", async () => {
    const sb = svc();
    const { error } = await sb.from("tenant_routines").insert({
      tenant_id: tenantA,
      agent_slug: AGENT,
      source_note_id: null,
      routine_name: "no-source routine",
      status: "candidate",
    });
    expect(error, `null source_note insert should succeed: ${error?.message}`).toBeNull();
  });

  it("(a) REJECTS a source_note that belongs to a DIFFERENT tenant", async () => {
    const sb = svc();
    const { error } = await sb.from("tenant_routines").insert({
      tenant_id: tenantA,
      agent_slug: AGENT,
      source_note_id: noteB_exp,
      routine_name: "cross-tenant link",
      status: "candidate",
    });
    expect(error, "cross-tenant source link must be rejected by the trigger").not.toBeNull();
    expect(error?.message ?? "").toMatch(/cross-tenant|belongs to tenant/i);
  });

  it("(b) REJECTS a source_note whose note_type is not agent_experience", async () => {
    const sb = svc();
    const { error } = await sb.from("tenant_routines").insert({
      tenant_id: tenantA,
      agent_slug: AGENT,
      source_note_id: noteA_wrongType,
      routine_name: "wrong-type link",
      status: "candidate",
    });
    expect(error, "non-agent_experience source link must be rejected").not.toBeNull();
    expect(error?.message ?? "").toMatch(/agent_experience/i);
  });

  it("(c) REJECTS a source_note that is for a DIFFERENT agent_slug", async () => {
    const sb = svc();
    const { error } = await sb.from("tenant_routines").insert({
      tenant_id: tenantA,
      agent_slug: AGENT,
      source_note_id: noteA_wrongAgent,
      routine_name: "wrong-agent link",
      status: "candidate",
    });
    expect(error, "wrong-agent source link must be rejected").not.toBeNull();
    expect(error?.message ?? "").toMatch(/wrong-agent|is for agent/i);
  });

  it("a member of tenant A cannot SELECT tenant B's tenant_routines rows", async () => {
    const sb = svc();
    const { data: planted, error: plantErr } = await sb
      .from("tenant_routines")
      .insert({
        tenant_id: tenantB,
        agent_slug: AGENT,
        source_note_id: noteB_exp,
        routine_name: "tenant B private routine",
        status: "candidate",
      })
      .select("id")
      .single();
    expect(plantErr, `plant B routine: ${plantErr?.message}`).toBeNull();

    const aClient = clientWithJwt(memberAJwt);

    const { data: ownRows, error: ownErr } = await aClient
      .from("tenant_routines")
      .select("id, tenant_id")
      .eq("tenant_id", tenantA);
    expect(ownErr, `tenant A self-read failed: ${ownErr?.message}`).toBeNull();
    expect((ownRows ?? []).length).toBeGreaterThan(0);
    expect((ownRows ?? []).every((r) => r.tenant_id === tenantA)).toBe(true);

    const { data: bRows, error: bErr } = await aClient
      .from("tenant_routines")
      .select("id, tenant_id")
      .eq("id", planted!.id);
    if (bErr) return;
    expect((bRows ?? []).length).toBe(0);
  });
});
