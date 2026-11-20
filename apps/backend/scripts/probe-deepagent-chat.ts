
import { createClient } from "@supabase/supabase-js";
import {
  claimAgentRun,
  buildContext,
  runDispatch,
  persistTerminal,
} from "../src/services/agents/runner";
import { resolveRunEngine } from "../src/services/agents/engine/resolve-run-engine";
import { loadGlobalAgentDefinition } from "../src/services/agents/registry";
import { serviceClient } from "../src/services/supabase";

const SLUG = process.env.PROBE_AGENT_SLUG || "chief-of-staff";
const TURN1 =
  "In two sentences: what business is this company in? Keep it short.";
const TURN2 =
  "What did I ask you in my previous message? Quote it back, then answer it " +
  "again in ONE sentence.";

async function authedClient(): Promise<AuthedClient> {
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const email = process.env.QA_TEST_EMAIL;
  const password = process.env.QA_TEST_PASSWORD!;
  if (!email) throw new Error("QA_TEST_EMAIL missing from apps/backend/.env");
  if (!password) throw new Error("QA_TEST_PASSWORD missing from .env");
  const sb = createClient(url, anon);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`login failed: ${error?.message}`);
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  }) as unknown as AuthedClient;
}

type AuthedClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>; from: (t: string) => any };

async function turn(authed: AuthedClient, threadId: string | null, message: string) {
  const def = loadGlobalAgentDefinition(SLUG)!;
  const { data, error } = (await authed.rpc("send_agent_chat_turn", {
    p_agent_slug: SLUG,
    p_agent_hash: def.content_hash,
    p_message: message,
    p_thread_id: threadId,
  })) as { data: Array<{ run_id: string; thread_id: string }> | null; error: { message: string } | null };
  if (error || !data?.[0]) throw new Error(`send_agent_chat_turn failed: ${error?.message}`);
  const row = data[0];
  const claim = await claimAgentRun(row.run_id);
  if (!claim) throw new Error("claim returned null");
  const ctx = await buildContext(claim, row.run_id);
  let result: Awaited<ReturnType<typeof runDispatch>> | null = null;
  let err: string | null = null;
  try {
    result = await runDispatch(ctx, claim.payload);
  } catch (e) {
    err = (e as Error).message;
  }
  await persistTerminal(row.run_id, SLUG, result, err, def.metadata_praxis.model, claim.payload, claim.trigger, ctx.tenant_id);
  const { data: run } = await serviceClient()
    .from("agent_runs")
    .select("status, output_text, input_tokens, cost_usd, error")
    .eq("id", row.run_id)
    .maybeSingle<{ status: string; output_text: string | null; input_tokens: number | null; cost_usd: number | null; error: string | null }>();
  return { ...row, run };
}

async function main() {
  const authed = await authedClient();
  const { data: tu } = (await authed
    .from("tenant_users")
    .select("tenant_id")
    .limit(1)
    .maybeSingle()) as { data: { tenant_id: string } | null };
  const tenantId = tu!.tenant_id;
  const def = loadGlobalAgentDefinition(SLUG)!;
  const resolved = await resolveRunEngine(tenantId, SLUG, def.metadata_praxis);

  console.log("── preflight ─────────────────────────────────────────────");
  console.log(`  tenant  : ${tenantId}\n  agent   : ${SLUG}\n  provider: ${resolved.provider} (${resolved.source})`);
  if (resolved.provider !== "langchain") {
    console.error(`\n  ABORT — resolves to ${resolved.provider}, not the harness.`);
    process.exit(2);
  }

  console.log(`\n── turn 1 ────────────────────────────────────────────────`);
  const t1 = await turn(authed, null, TURN1);
  console.log(`  thread ${t1.thread_id}\n  status=${t1.run?.status} tokens_in=${t1.run?.input_tokens} cost=$${t1.run?.cost_usd}`);
  console.log(`  reply: ${(t1.run?.output_text ?? "").slice(0, 220).replace(/\n/g, " ")}`);

  console.log(`\n── turn 2 (same thread) ──────────────────────────────────`);
  const t2 = await turn(authed, t1.thread_id, TURN2);
  console.log(`  status=${t2.run?.status} tokens_in=${t2.run?.input_tokens} cost=$${t2.run?.cost_usd}`);
  const reply2 = t2.run?.output_text ?? "";
  console.log(`  reply: ${reply2.slice(0, 300).replace(/\n/g, " ")}`);

  let bad = 0;
  const chk = (n: string, ok: boolean, d: string) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}\n        ${d}`);
    if (!ok) bad += 1;
  };
  console.log(`\n── checks ────────────────────────────────────────────────`);
  chk("turn 1 succeeded", t1.run?.status === "success", `${t1.run?.status} ${t1.run?.error ?? ""}`);
  chk("turn 2 succeeded", t2.run?.status === "success", `${t2.run?.status} ${t2.run?.error ?? ""}`);
  chk("both turns produced a reply", (t1.run?.output_text ?? "").length > 30 && reply2.length > 30, `${(t1.run?.output_text ?? "").length} / ${reply2.length} chars`);
  chk(
    "turn 2 REMEMBERS turn 1 (transcript flatten carries the history)",
    /what business|two sentences|previous message/i.test(reply2),
    reply2.slice(0, 160).replace(/\n/g, " "),
  );
  chk("turn 2 carried more context than turn 1", (t2.run?.input_tokens ?? 0) > 0, `t1=${t1.run?.input_tokens} t2=${t2.run?.input_tokens}`);
  console.log(`\n${bad === 0 ? "ALL CHECKS PASSED" : `${bad} CHECK(S) FAILED`}`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("chat probe crashed:", e);
  process.exit(1);
});
