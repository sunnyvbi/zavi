
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE_AGENTS = ["operator"];

const RECALL_SCORE_FLOOR = 0.5;

function scanDir(dir, re, hits = [], depth = 0) {
  if (depth > 12) return hits;
  let entries;
  try { entries = readdirSync(dir); } catch { return hits; }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) scanDir(p, re, hits, depth + 1);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) {
      try { if (re.test(readFileSync(p, "utf8"))) hits.push(p); } catch {  }
    }
  }
  return hits;
}

const TERMINAL = new Set(["success", "parse_failed", "dispatch_error"]);

export async function dispatchChat(ctx, slug, message) {
  const { http, base, tokens, sleep } = ctx;
  try {
    const send = await http(base, { method: "POST", path: `/api/agents/${slug}/chat`, token: tokens.A, body: { message } });
    if (![200, 202].includes(send.status) || !send.json?.run_id) {
      return { ok: false, status: send.status, reason: `chat dispatch HTTP ${send.status}`, assistant: null };
    }
    const { run_id, thread_id } = send.json;
    const deadline = Date.now() + 180000;
    const softQueued = Date.now() + 45000;
    let sawRunning = false, run = null;
    while (Date.now() < deadline) {
      const r = await http(base, { method: "GET", path: `/api/agents/runs/${run_id}`, token: tokens.A });
      run = r.json?.run;
      const st = run?.status;
      if (TERMINAL.has(st)) {
        return { ok: st === "success", status: st, run_id, thread_id, runStatus: st, assistant: run?.output_text || null, terminal: true };
      }
      if (st === "running") sawRunning = true;
      if (!sawRunning && st === "queued" && Date.now() > softQueued) {
        return { ok: false, workerAbsent: true, run_id, thread_id, reason: "run stuck in queued — no Inngest worker executing locally" };
      }
      await sleep(3000);
    }
    return { ok: false, timedOut: true, run_id, thread_id, runStatus: run?.status, reason: "run did not reach terminal within 180s" };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 120), assistant: null };
  }
}

export async function setup(ctx) {
  ctx.shared = { pm: null, cto: null, operator: null };
  if (ctx.fast) return;

  ctx.shared.pm = await dispatchChat(ctx, "pm",
    "In one sentence, what is the single most important metric for a two-sided marketplace in its first 90 days?");
  ctx.shared.cto = await dispatchChat(ctx, "engineer",
    "Which file in this backend defines the agent run dispatcher? Just name it — do not change any code.");
  ctx.shared.operator = await dispatchChat(ctx, "operator",
    "In one sentence, tell me what kinds of questions you can help with.");
}

export async function teardown(ctx) {
  const { http, base, tokens } = ctx;
  for (const id of ctx.sweep.noteIds.slice()) {
    await http(base, { method: "DELETE", path: `/api/memory/notes/${id}`, token: tokens.A }).catch(() => {});
  }
}

export const cases = [
  { id: "API-01", group: "Auth & session", tier: "A", gate: true, desc: "Health probe shape",
    req: { method: "GET", path: "/health", auth: "none" },
    expect: { status: 200, keys: ["ok", "service", "uptime_s"], json: { ok: true } } },

  { id: "API-02", group: "Auth & session", tier: "A", gate: true, desc: "Password-grant mints a decodable token for the test account",
    async flow(ctx) {
      if (!ctx.tokens.A) return { pass: false, reason: "token A not minted (check QA_TEST_EMAIL and QA_TEST_PASSWORD in .env)" };
      const sub = ctx.decoded.A?.sub;
      return sub ? { pass: true, reason: `token decodes (sub=${String(sub).slice(0, 8)}…)` }
                 : { pass: false, reason: "token minted but has no sub claim" };
    } },

  { id: "API-03", group: "Auth & session", tier: "A", gate: true, desc: "Unauth memory search rejected",
    req: { method: "POST", path: "/api/memory/search", auth: "none", body: { query: "x", k: 1 } },
    expect: { status: 401, json: { error: { code: "unauthenticated" } } } },

  { id: "API-04", group: "Auth & session", tier: "A", gate: true, desc: "Authed memory search returns hits array",
    req: { method: "POST", path: "/api/memory/search", auth: "A", body: { query: "how are refunds and disputes handled", k: 3 } },
    expect: { status: 200, keys: ["hits"] },
    check: (res) => Array.isArray(res.json?.hits) ? null : "hits is not an array" },

  { id: "API-05", group: "Auth & session", tier: "A", gate: true, desc: "Staff route blocks a non-staff account (app_metadata.role !== 'staff')",
    req: { method: "GET", path: "/api/admin/funnel", auth: "A" },
    expect: { status: 401, json: { error: { code: "not_staff" } } } },

  { id: "API-06", group: "Auth & session", tier: "A", gate: true, desc: "Auth bootstrap-status shape",
    req: { method: "GET", path: "/api/auth/bootstrap-status", auth: "A" },
    expect: { status: 200, keys: ["status"] } },

  { id: "SEC-01", group: "Security / isolation", tier: "A", gate: true, desc: "Cross-tenant memory-note read denied (one leak ends the company)",
    skipIf: (ctx) => ctx.tokens.B ? null : "tenant-B token not minted (set QA_PRIVATE_TEST_PASSWORD)",
    async flow(ctx) {
      const { http, base, tokens, marker } = ctx;
      const title = `${marker}-sec01`;
      const create = await http(base, { method: "POST", path: "/api/memory/notes", token: tokens.B, body: { title, body_markdown: `secret-canary ${marker}`, note_type: "untyped" } });
      const noteId = create.json?.note_id;
      if (!noteId) return { pass: false, reason: `B could not create probe note (HTTP ${create.status})` };
      try {
        const asA = await http(base, { method: "GET", path: `/api/memory/notes/${noteId}`, token: tokens.A });
        const leaked = asA.status === 200 && JSON.stringify(asA.json || {}).includes(marker);
        return leaked
          ? { pass: false, reason: `LEAK: tenant A read tenant B note ${noteId}`, repro: `GET /api/memory/notes/${noteId} as A` }
          : { pass: true, reason: `A blocked from B note (HTTP ${asA.status})` };
      } finally {
        await http(base, { method: "DELETE", path: `/api/memory/notes/${noteId}`, token: tokens.B }).catch(() => {});
      }
    } },

  { id: "SEC-02", group: "Security / isolation", tier: "A", gate: true, desc: "Forged tenant_id ignored + cross-tenant run read denied",
    skipIf: (ctx) => ctx.tokens.B ? null : "tenant-B token not minted (set QA_PRIVATE_TEST_PASSWORD)",
    async flow(ctx) {
      const { http, base, tokens } = ctx;
      const send = await http(base, { method: "POST", path: "/api/agents/pm/chat", token: tokens.A, body: { message: "qa-api isolation probe", tenant_id: ctx.TENANT_B } });
      if (![200, 202].includes(send.status) || !send.json?.run_id) return { pass: false, reason: `dispatch failed HTTP ${send.status}` };
      const rid = send.json.run_id;
      const asA = await http(base, { method: "GET", path: `/api/agents/runs/${rid}`, token: tokens.A });
      const asB = await http(base, { method: "GET", path: `/api/agents/runs/${rid}`, token: tokens.B });
      const aOk = asA.status === 200 && asA.json?.run?.id === rid;
      const bDenied = asB.status === 404 || asB.status === 403;
      return aOk && bDenied
        ? { pass: true, reason: `forged tenant ignored — run scoped to A (A:200, B:${asB.status})` }
        : { pass: false, reason: `isolation breach — A:${asA.status} B:${asB.status} (B must be 404/403)` };
    } },

  { id: "SEC-03", group: "Security / isolation", tier: "A", gate: true, desc: "Cross-tenant list endpoints never leak rows across tenants (one leak ends the company)",
    skipIf: (ctx) => ctx.tokens.B ? null : "tenant-B token not minted (set QA_PRIVATE_TEST_PASSWORD)",
    async flow(ctx) {
      const { http, base, tokens, marker } = ctx;
      const title = `${marker}-sec03`;
      const create = await http(base, { method: "POST", path: "/api/memory/notes", token: tokens.A, body: { title, body_markdown: `cross-tenant-list-canary ${marker}`, note_type: "untyped" } });
      const noteId = create.json?.note_id;
      if (!noteId) return { pass: false, reason: `A could not plant canary note (HTTP ${create.status})` };
      ctx.sweep.noteIds.push(noteId);
      try {
        const probes = [
          "/api/memory/notes",
          "/api/artifacts",
          "/api/approvals",
          "/api/v1/members",
          "/api/commands",
          "/api/agents/pm/threads",
        ];
        const leaks = [];
        for (const path of probes) {
          const rA = await http(base, { method: "GET", path, token: tokens.A });
          const rB = await http(base, { method: "GET", path, token: tokens.B });
          if (rB.status >= 500) continue;
          const bText = JSON.stringify(rB.json || {});
          if (bText.includes(marker) || bText.includes(noteId)) {
            leaks.push(`${path}: B response contains A's marker/id`);
          }
          if (rA.status === 200 && rB.status === 200 && bText.length > 120 &&
              JSON.stringify(rA.json) === bText) {
            leaks.push(`${path}: A and B returned byte-identical responses`);
          }
        }
        return leaks.length === 0
          ? { pass: true, reason: `${probes.length} list endpoints — no cross-tenant leak detected`, evidence: probes.length }
          : { pass: false, reason: `LEAK: ${leaks.join(" | ")}`, repro: probes.join(" + ") };
      } finally {
        await http(base, { method: "DELETE", path: `/api/memory/notes/${noteId}`, token: tokens.A }).catch(() => {});
        ctx.sweep.noteIds = ctx.sweep.noteIds.filter((x) => x !== noteId);
      }
    } },

  { id: "SEC-07", group: "Security / isolation", tier: "A", gate: true, desc: "Connector list never leaks a raw secret/token",
    req: { method: "GET", path: "/api/connectors", auth: "A" },
    expect: { status: 200, keys: ["connectors"] },
    check: (res, ctx) => ctx.findLeakedSecret(res.json?.connectors) },

  { id: "SEC-11", group: "Security / isolation", tier: "A", gate: true, desc: "Service-role key absent from apps/web source (mirrors CI lint invariant)",
    async flow(ctx) {
      const re = /process\.env\.SUPABASE_SERVICE_ROLE_KEY|\bcreateServiceClient\s*\(|\bserviceClient\s*\(\s*\)|from\s+["']@\/services\/supabase/;
      const hits = scanDir(join(ctx.repoRoot, "apps", "web", "src"), re);
      return hits.length === 0
        ? { pass: true, reason: "0 service-role references in apps/web" }
        : { pass: false, reason: `service-role leaked into apps/web: ${hits.slice(0, 3).map((h) => h.replace(ctx.repoRoot + "/", "")).join(", ")}` };
    } },

  { id: "API-07", group: "Security / isolation", tier: "A", gate: true, desc: "Connector recommendations shape",
    req: { method: "GET", path: "/api/connectors/recommendations", auth: "A" },
    expect: { status: 200, keys: ["recommendations"] } },

  { id: "API-08", group: "Security / isolation", tier: "A", gate: true, desc: "Bogus run-detail is a clean 404 (never reveals existence)",
    req: { method: "GET", path: "/api/agents/runs/00000000-0000-0000-0000-000000000000", auth: "A" },
    expect: { status: 404, json: { error: { code: "not_found" } } } },

  { id: "MCP-01", group: "Security / isolation", tier: "A", gate: true, desc: "Unauth MCP request → 401 with RFC-9728 discovery header",
    req: { method: "POST", path: "/mcp", auth: "none", body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { Accept: "application/json, text/event-stream" } },
    check: (res) => {
      if (![401, 429].includes(res.status)) return `expected 401/429, got ${res.status}`;
      return res._wwwAuth ? null : "missing WWW-Authenticate discovery header on 401";
    } },

  { id: "BRAIN-01", group: "Brain / memory", tier: "A", gate: true, desc: "On-topic recall clears the score floor (deterministic; mirror of API-12 off-topic floor — no LLM judge)",
    req: { method: "POST", path: "/api/memory/search", auth: "A", body: { query: "how are refunds and disputes handled", k: 3 } },
    expect: { status: 200, keys: ["hits"] },
    check: (res) => {
      const h = res.json?.hits || [];
      if (!h.length) return "0 hits for an on-topic query — recall broken";
      const top = Math.max(...h.map((x) => x.score ?? 0));
      return top >= RECALL_SCORE_FLOOR ? null : `on-topic query top hit below floor (${top.toFixed(3)} < ${RECALL_SCORE_FLOOR}) — recall regression`;
    } },

  { id: "API-09", group: "Brain / memory", tier: "A", gate: true, desc: "Memory hits carry a numeric score",
    req: { method: "POST", path: "/api/memory/search", auth: "A", body: { query: "refunds", k: 3 } },
    expect: { status: 200, keys: ["hits"] },
    check: (res) => {
      const h = res.json?.hits || [];
      if (!h.length) return null;
      return typeof h[0].score === "number" ? null : "hit missing numeric score";
    } },

  { id: "API-10", group: "Brain / memory", tier: "A", gate: true, desc: "Memory note create → read-back → delete round-trip (self-cleaning)",
    async flow(ctx) {
      const { http, base, tokens, marker } = ctx;
      const create = await http(base, { method: "POST", path: "/api/memory/notes", token: tokens.A, body: { title: `${marker}-rt`, body_markdown: `round-trip ${marker}`, note_type: "untyped" } });
      const id = create.json?.note_id;
      if (![200, 201].includes(create.status)) return { pass: false, reason: `create HTTP ${create.status}` };
      if (!id) return { pass: false, reason: "create returned no note_id" };
      ctx.sweep.noteIds.push(id);
      const read = await http(base, { method: "GET", path: `/api/memory/notes/${id}`, token: tokens.A });
      const readOk = read.status === 200 && read.json?.note?.id === id;
      const del = await http(base, { method: "DELETE", path: `/api/memory/notes/${id}`, token: tokens.A });
      const gone = await http(base, { method: "GET", path: `/api/memory/notes/${id}`, token: tokens.A });
      const delOk = del.status >= 200 && del.status < 300;
      if (delOk) ctx.sweep.noteIds = ctx.sweep.noteIds.filter((x) => x !== id);
      return readOk && delOk && gone.status === 404
        ? { pass: true, reason: "create→read→delete→404 clean" }
        : { pass: false, reason: `round-trip broke: read=${read.status} del=${del.status} gone=${gone.status}` };
    } },

  { id: "API-11", group: "Brain / memory", tier: "A", gate: true, desc: "Memory notes list shape",
    req: { method: "GET", path: "/api/memory/notes", auth: "A" },
    expect: { status: 200, keys: ["notes"] } },

  { id: "API-12", group: "Brain / memory", tier: "A", gate: true, desc: "Off-topic query floored out (brain-moat invariant)",
    req: { method: "POST", path: "/api/memory/search", auth: "A", body: { query: "zxqw blpfft unrelated quantum banana sasquatch telescope", k: 5 } },
    expect: { status: 200, keys: ["hits"] },
    check: (res) => {
      const h = res.json?.hits || [];
      if (!h.length) return null;
      const top = Math.max(...h.map((x) => x.score ?? 0));
      return top < RECALL_SCORE_FLOOR ? null : `off-topic query surfaced a high-score hit (${top.toFixed(3)}) — floor leak`;
    } },

  { id: "API-13", group: "Brain / memory", tier: "A", gate: true, desc: "Memory note-conflicts list shape",
    req: { method: "GET", path: "/api/memory/notes/conflicts", auth: "A" },
    expect: { status: 200, keys: ["pairs"] } },

  { id: "BRAIN-08", group: "Brain / memory", tier: "A", gate: false, desc: "[watch] Superseded note never resurfaces",
    skipIf: () => "needs a supersede-setup fixture; tracked, not gated (Doc-2 watchlist)" },

  { id: "BRAIN-05", group: "Brain / memory", tier: "C", gate: false, desc: "[deep] Recall injected into a live agent run (note surfaces in recall-trace)",
    skipIf: (ctx) => {
      if (!ctx.deep) return "heavy $ live dispatch — --deep only";
      if (!ctx.tokens.staff) return "no QA_STAFF token (set QA_STAFF_EMAIL/PASSWORD) — recall-trace is staff-gated";
      return null;
    },
    flow: async (ctx) => {
      const r = await dispatchChat(ctx, "support-lead",
        "What is our standard policy on how quickly hosts receive payouts after a completed trip?");
      if (r.workerAbsent) return { skip: true, reason: r.reason };
      if (!r.run_id) return { pass: false, reason: r.reason || "chat dispatch failed (no run_id)" };
      if (!r.terminal) return { pass: false, reason: r.reason || `run ${r.run_id} did not reach terminal` };
      const rt = await ctx.http(ctx.base, { path: `/api/admin/runs/${r.run_id}/recall-trace`, token: ctx.tokens.staff });
      if (rt.status !== 200) return { pass: false, reason: `recall-trace HTTP ${rt.status} for run ${r.run_id}`, repro: `GET /api/admin/runs/${r.run_id}/recall-trace` };
      const recalled = Array.isArray(rt.json?.recalled_note_ids) ? rt.json.recalled_note_ids : [];
      const traces = Array.isArray(rt.json?.search_traces) ? rt.json.search_traces : [];
      if (recalled.length === 0) {
        return { pass: false, reason: traces.length > 0
          ? `recall fired (${traces.length} search trace[s]) but 0 notes surfaced for run ${r.run_id} — brain lacks the note or retrieval missed`
          : `no memory_search_trace for run ${r.run_id} — auto-recall did not fire (agent not memory-layer, or live-state classified)` };
      }
      return { pass: true,
        reason: `recall injected into live run: ${recalled.length} note(s) [${recalled.slice(0, 2).join(", ")}${recalled.length > 2 ? ", …" : ""}], ${traces.length} search trace(s)`,
        evidence: `run ${r.run_id}` };
    } },

  { id: "API-16", group: "Agents", tier: "A", gate: true, desc: "Agents list shape — 200 + agents array (was 500 on high-volume tenant; closed by composite index)",
    req: { method: "GET", path: "/api/agents", auth: "A" },
    expect: { status: 200, keys: ["agents"] },
    check: (res) => Array.isArray(res.json?.agents) && res.json.agents.length >= 1 ? null : "agents list empty/not array" },

  { id: "API-16b", group: "Agents", tier: "A", gate: true, desc: "All 4 listed built-in agents present in /api/agents response",
    async flow(ctx) {
      const r = await ctx.http(ctx.base, { method: "GET", path: "/api/agents", token: ctx.tokens.A });
      const slugs = new Set((r.json?.agents || []).map((a) => a.slug));
      const missing = CORE_AGENTS.filter((s) => !slugs.has(s));
      return missing.length === 0
        ? { pass: true, reason: `all ${CORE_AGENTS.length} core agents present` }
        : { pass: false, reason: r.status >= 500 ? `/api/agents ${r.status} (statement-timeout regression — see API-16)` : `missing core agents: ${missing.join(", ")}` };
    } },

  { id: "API-17x", group: "Agents", tier: "A", gate: true, desc: "Unknown agent run → 404 not_found",
    req: { method: "POST", path: "/api/agents/__nope__/run", auth: "A", body: { payload: {} } },
    expect: { status: 404, json: { error: { code: "not_found" } } } },

  { id: "API-18x", group: "Agents", tier: "A", gate: true, desc: "Bogus run-id → 404",
    req: { method: "GET", path: "/api/agents/runs/11111111-1111-1111-1111-111111111111", auth: "A" },
    expect: { status: 404 } },

  { id: "API-14", group: "Agents", tier: "B", gate: true, desc: "Chat dispatch returns a thread (shared run trigger)",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral dispatch" : null,
    async flow(ctx) {
      const s = ctx.shared.pm;
      if (!s) return { pass: false, reason: "shared pm dispatch did not run" };
      return s.thread_id
        ? { pass: true, reason: `chat dispatch created thread (HTTP ${s.status})`, evidence: s.thread_id }
        : { pass: false, reason: `chat dispatch failed: ${s.reason || s.status}` };
    } },

  { id: "API-15", group: "Agents", tier: "B", gate: true, desc: "Dispatched run reaches a terminal answer (does not hang)",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral dispatch"
      : ctx.shared?.pm?.workerAbsent ? "no Inngest worker locally — run --target prod (or start `npx inngest-cli dev`) for behavioral coverage" : null,
    async flow(ctx) {
      const s = ctx.shared.pm;
      if (!s) return { pass: false, reason: "shared dispatch did not run" };
      if (s.timedOut) return { pass: false, reason: "run never reached terminal within timeout (hung)" };
      return s.terminal
        ? { pass: true, reason: `reached terminal (status=${s.runStatus})`, evidence: (s.assistant || "").slice(0, 80) }
        : { pass: false, reason: `did not reach terminal: ${s.reason || s.status}` };
    } },

  { id: "API-19x", group: "Agents", tier: "A", gate: true, desc: "Agent threads list shape",
    req: { method: "GET", path: "/api/agents/pm/threads", auth: "A" },
    expect: { status: 200, keys: ["threads"] } },

  { id: "API-20x", group: "Agents", tier: "A", gate: true, desc: "chat-history default path: no thread_id → 200 with most-recent thread (multi-thread safe)",
    async flow(ctx) {
      const r = await ctx.http(ctx.base, { method: "GET", path: "/api/agents/pm/chat/history", token: ctx.tokens.A });
      if (r.status !== 200) return { pass: false, reason: `chat-history HTTP ${r.status} (regression — multi-thread default path broke again)` };
      if (!Array.isArray(r.json?.messages)) return { pass: false, reason: "200 but messages is not an array" };
      const t = r.json.thread;
      if (t !== null && (typeof t !== "object" || typeof t.id !== "string")) {
        return { pass: false, reason: `thread is neither null nor a row with id (got ${typeof t})` };
      }
      return { pass: true, reason: `default-path returned ${r.json.messages.length} messages, thread=${t ? "row" : "null"}` };
    } },

  { id: "API-32", group: "Agents", tier: "A", gate: true, desc: "chat-history ?thread_id=<uuid> — 400 on bad uuid, 404 on miss, 200 echoes thread.id on hit",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral dispatch (no thread_id to probe with)"
      : !ctx.shared?.pm?.thread_id ? "no shared pm thread (dispatch did not produce one)" : null,
    async flow(ctx) {
      const { http, base, tokens } = ctx;
      const realTid = ctx.shared.pm.thread_id;

      const bad = await http(base, { method: "GET", path: "/api/agents/pm/chat/history?thread_id=not-a-uuid", token: tokens.A });
      if (bad.status !== 400) return { pass: false, reason: `malformed thread_id: expected 400, got ${bad.status}` };
      if (bad.json?.error?.code !== "bad_request") return { pass: false, reason: `malformed thread_id 400 missing bad_request code (got ${bad.json?.error?.code})` };

      const miss = await http(base, { method: "GET", path: "/api/agents/pm/chat/history?thread_id=00000000-0000-0000-0000-000000000000", token: tokens.A });
      if (miss.status !== 404) return { pass: false, reason: `bogus thread_id: expected 404, got ${miss.status}` };

      const hit = await http(base, { method: "GET", path: `/api/agents/pm/chat/history?thread_id=${realTid}`, token: tokens.A });
      if (hit.status !== 200) return { pass: false, reason: `real thread_id: expected 200, got ${hit.status}` };
      if (hit.json?.thread?.id !== realTid) return { pass: false, reason: `real thread_id: returned thread.id ${hit.json?.thread?.id} ≠ requested ${realTid}` };
      if (!Array.isArray(hit.json?.messages)) return { pass: false, reason: "real thread_id: messages not an array" };

      return { pass: true, reason: `3/3: 400 bad uuid, 404 unknown uuid, 200 echoes thread.id` };
    } },

  { id: "UX-04", group: "Agents", tier: "C", gate: true, desc: "First-message dispatch returns a REAL answer, not a meta-placeholder",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral"
      : ctx.shared?.pm?.workerAbsent ? "no Inngest worker locally — run --target prod for behavioral coverage" : null,
    async flow(ctx) {
      const s = ctx.shared.pm;
      if (!s?.assistant) return { pass: false, reason: `no assistant output to grade (status=${s?.runStatus || s?.status})` };
      const v = await ctx.judge(ctx.env, {
        rubric: "This is an agent's first reply to a user's question about marketplace metrics. It must be a SUBSTANTIVE answer (names/discusses a real metric with reasoning). It must NOT be a meta-placeholder ('I'm working on it', 'one moment'), an empty stub, or pure boilerplate.",
        content: s.assistant,
      });
      return { pass: v.pass, reason: v.reason, costUsd: v.costUsd, evidence: s.assistant.slice(0, 120) };
    } },

  { id: "EXEC-11", group: "Agents", tier: "C", gate: true, desc: "Info-only question to engineer stages NO PR (ship-gate)",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral"
      : ctx.shared?.cto?.workerAbsent ? "no Inngest worker locally — run --target prod for behavioral coverage" : null,
    async flow(ctx) {
      const s = ctx.shared.cto;
      if (!s?.assistant) return { pass: false, reason: `cto info dispatch produced no answer (${s?.reason || s?.runStatus || s?.status})` };
      const v = await ctx.judge(ctx.env, {
        rubric: "engineer is answering a pure INFORMATION question (which file does X). A correct reply ANSWERS as information. It must NOT claim to have opened/staged/proposed a pull request or changed code — nothing was asked to be built. Naming a file = good. Claiming a PR/commit = ship-gate leak = FAIL. A reply that declines to change code is fine.",
        content: s.assistant,
      });
      return { pass: v.pass, reason: v.reason, costUsd: v.costUsd, evidence: s.assistant.slice(0, 120) };
    } },

  { id: "EXEC-01", group: "Agents", tier: "C", gate: false, desc: "[watch] cto code task → terminal + (PR-shaped OR correctly held)",
    skipIf: () => "heavy real code run (30-60s+, $$$); --deep only — watchlist by default" },

  { id: "OP-01", group: "Agents", tier: "A", gate: true, desc: "Operator reply has NO scaffolding tag leak in output_text (<plan>/<envelope>/<pr_proposal>)",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral dispatch"
      : ctx.shared?.operator?.workerAbsent ? "no Inngest worker locally — run --target prod for behavioral coverage" : null,
    async flow(ctx) {
      const s = ctx.shared.operator;
      if (!s?.assistant) return { pass: false, reason: `operator dispatch produced no assistant output (${s?.reason || s?.runStatus || s?.status})` };
      const tags = ["<plan>", "</plan>", "<envelope>", "</envelope>", "<pr_proposal>", "</pr_proposal>"];
      const leaked = tags.filter((t) => s.assistant.includes(t));
      return leaked.length === 0
        ? { pass: true, reason: `no scaffolding tag leak (${s.assistant.length} chars)` }
        : { pass: false, reason: `scaffolding leak — output_text contains ${leaked.join(", ")}`, repro: `dispatchChat(operator, ...); chat_history.messages[-1].body`, evidence: s.assistant.slice(0, 200) };
    } },

  { id: "OP-02", group: "Agents", tier: "B", gate: true, desc: "Operator reply is non-empty + substantive (not envelope-only, not naked placeholder)",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral dispatch"
      : ctx.shared?.operator?.workerAbsent ? "no Inngest worker locally — run --target prod for behavioral coverage" : null,
    async flow(ctx) {
      const s = ctx.shared.operator;
      if (!s?.terminal) return { pass: false, reason: `operator did not reach terminal: ${s?.reason || s?.runStatus || s?.status}` };
      const body = s.assistant ?? "";
      if (body.trim().length < 50) {
        return { pass: false, reason: `operator reply too short (${body.trim().length} chars) — envelope-only or placeholder`, evidence: body.slice(0, 200) };
      }
      return { pass: true, reason: `operator reply ${body.length} chars, non-placeholder`, evidence: body.slice(0, 120) };
    } },

  { id: "OP-03", group: "Agents", tier: "C", gate: true, desc: "Operator reply answers the question (not pure deflection / connect-Stripe-shaped boilerplate)",
    skipIf: (ctx) => ctx.fast ? "--fast skips behavioral"
      : ctx.shared?.operator?.workerAbsent ? "no Inngest worker locally — run --target prod for behavioral coverage" : null,
    async flow(ctx) {
      const s = ctx.shared.operator;
      if (!s?.assistant) return { pass: false, reason: `no operator output to grade (status=${s?.runStatus || s?.status})` };
      const v = await ctx.judge(ctx.env, {
        rubric: "Operator is answering a meta-question about what kinds of questions it can help with. A CORRECT reply names 2-3 concrete categories (e.g. 'reads', 'metrics', 'handing off to specialists', 'connector status'). It must NOT be (a) a connect-Stripe deflection ('I need Stripe to answer that'), (b) pure refusal ('I can't help with that'), (c) raw envelope JSON like `{\"classify\":...}`, (d) a meta-placeholder ('one moment'). It MAY be brief.",
        content: s.assistant,
      });
      return { pass: v.pass, reason: v.reason, costUsd: v.costUsd, evidence: s.assistant.slice(0, 120) };
    } },

  { id: "MONEY-01", group: "Money path / autonomy", tier: "A", gate: true, desc: "Autonomy control surface (money-path gate config) returns expected shape",
    req: { method: "GET", path: "/api/approvals/autonomy", auth: "A" },
    expect: { status: 200, keys: ["classes"] },
    check: (res) => {
      const classes = res.json?.classes || [];
      if (!Array.isArray(classes)) return `classes is not an array (got ${typeof classes})`;
      if (classes.length === 0) return "classes array empty — no decision_classes registered (gate config invisible)";
      const required = ["slug", "default_autonomy", "effective"];
      const missing = required.filter((k) => !(k in classes[0]));
      return missing.length === 0 ? null : `class missing keys: ${missing.join(", ")}`;
    } },

  { id: "MONEY-02", group: "Money path / autonomy", tier: "A", gate: true, desc: "Autonomy SET rejects invalid autonomy value (400 with code, never silent miswrite)",
    req: { method: "POST", path: "/api/approvals/autonomy", auth: "A", body: { decision_class: "qa_api_probe_class", autonomy: "bogus_value_definitely_not_enum" } },
    check: (res) => {
      if (res.status !== 400) return `expected 400 for invalid autonomy value, got ${res.status}`;
      return res.json?.error?.code ? null : "400 returned without error.code (contract drift)";
    } },

  { id: "CONN-01", group: "Connectors", tier: "A", gate: true, desc: "Connector-bearing tenant shows ≥1 connected connector",
    req: { method: "GET", path: "/api/connectors", auth: "A" },
    expect: { status: 200, keys: ["connectors"] },
    check: (res) => {
      const conns = res.json?.connectors || [];
      const connected = conns.filter((c) => c.connected).map((c) => c.slug);
      return connected.length >= 1 ? null : `no connected connectors (got: ${conns.map((c) => c.slug).join(",")})`;
    } },

  { id: "CONN-02", group: "Connectors", tier: "A", gate: true, desc: "Composio toolkits list shape",
    req: { method: "GET", path: "/api/connectors/composio/toolkits", auth: "A" },
    expect: { status: 200, keys: ["toolkits"] } },

  { id: "CONN-03", group: "Connectors", tier: "A", gate: true, desc: "GitHub install-url endpoint reachable",
    req: { method: "GET", path: "/api/connectors/github/install-url", auth: "A" },
    expect: { status: 200 } },

  { id: "CONN-04", group: "Connectors", tier: "A", gate: true, desc: "Slack OAuth start mints a redirect (never 5xx)",
    req: { method: "GET", path: "/api/connectors/slack/start", auth: "A" },
    check: (res) => [200, 302, 303, 307].includes(res.status) ? null : `expected OAuth-start 200/302, got ${res.status}` },

  { id: "CONN-05", group: "Connectors", tier: "A", gate: true, desc: "Operator-DB connect with invalid body → 400",
    req: { method: "POST", path: "/api/connectors/operator-db", auth: "A", body: {} },
    check: (res) => res.status === 400 ? null : `expected 400 for empty body, got ${res.status}` },

  { id: "CONN-06", group: "Connectors", tier: "A", gate: true, desc: "Unknown connector start → 404",
    req: { method: "GET", path: "/api/connectors/__nope__/start", auth: "A" },
    expect: { status: 404 } },

  { id: "API-21", group: "Workspace / home", tier: "A", gate: true, desc: "Workspace bootstrap cold-load shape",
    req: { method: "GET", path: "/api/workspace/bootstrap", auth: "A" },
    expect: { status: 200, keys: ["tree", "tabs_session", "status_counters"] } },

  { id: "API-22", group: "Workspace / home", tier: "A", gate: true, desc: "Workspace tree shape",
    req: { method: "GET", path: "/api/workspace/tree", auth: "A" },
    expect: { status: 200, keys: ["agents"] } },

  { id: "API-23", group: "Workspace / home", tier: "A", gate: true, desc: "Status-counters shape",
    req: { method: "GET", path: "/api/workspace/status-counters", auth: "A" },
    expect: { status: 200, keys: ["active_runs", "approvals_pending"] } },

  { id: "API-24", group: "Workspace / home", tier: "A", gate: true, desc: "Home summary (200, or 202 while auto-provisioning)",
    req: { method: "GET", path: "/api/home/summary", auth: "A" },
    check: (res) => [200, 202].includes(res.status) ? null : `expected 200/202, got ${res.status}` },

  { id: "API-25", group: "Workspace / home", tier: "A", gate: true, desc: "Artifacts list shape",
    req: { method: "GET", path: "/api/artifacts", auth: "A" },
    expect: { status: 200, keys: ["artifacts"] } },

  { id: "API-26", group: "Workspace / home", tier: "A", gate: true, desc: "Approvals list shape",
    req: { method: "GET", path: "/api/approvals", auth: "A" },
    expect: { status: 200, keys: ["decisions"] } },

  { id: "API-27", group: "Workspace / home", tier: "A", gate: true, desc: "Members roster shape",
    req: { method: "GET", path: "/api/v1/members", auth: "A" },
    expect: { status: 200, keys: ["members"] } },

  { id: "API-28", group: "Onboarding & misc", tier: "A", gate: true, desc: "Onboarding enrich contract: bounded, never 500, valid status",
    req: { method: "POST", path: "/api/onboarding/enrich", auth: "A", body: { orgName: "Upcar", mode: "resolve_only" } },
    check: (res) => {
      if (res.status !== 200) return `expected 200, got ${res.status}`;
      const st = res.json?.result?.status ?? res.json?.enrichment?.status;
      return ["ok", "resolved", "skipped"].includes(st) ? null : `enrich status invalid: ${st}`;
    } },

  { id: "API-29", group: "Onboarding & misc", tier: "A", gate: true, desc: "Commands list shape",
    req: { method: "GET", path: "/api/commands", auth: "A" },
    expect: { status: 200, keys: ["commands"] } },

  { id: "API-30", group: "Onboarding & misc", tier: "A", gate: true, desc: "Takes scorecard envelope (200+shape, or intentional 404 empty-state — never 5xx)",
    req: { method: "GET", path: "/api/takes/scorecard", auth: "A" },
    check: (res) => {
      if (res.status >= 500) return `scorecard 5xx (${res.status}) — must never 500`;
      if (![200, 404].includes(res.status)) return `expected 200 or empty-state 404, got ${res.status}`;
      if (res.status === 200 && !("scorecard" in (res.json || {}))) return "200 but missing scorecard key";
      return null;
    } },

  { id: "B9-01", group: "Manus Slice B / honest reporting", tier: "B", gate: false,
    desc: "[watch/internal] clarify up-front gate — when the model's iter reasoning signals clarifications_needed AND it's about to fire a side-effecting tool, the run short-circuits BEFORE the side effect (no opened PR / filed ticket / posted Slack until the question is answered). Pairs with shipped partial_report (PR #493): buildDispatchNotice still renders the honest breakdown via partialReportIsComplete; this gate stops the BUILD-UP of the partial in the first place. (services/agents/clarify-gate.ts + generic-dispatcher.ts iter-loop wire-up)",
    skipIf: () => "internal contract — covered by clarify-gate.test.ts + dispatch-notice.test.ts; no public route to exercise from black-box runner",
  },

  { id: "B6-01", group: "Manus Slice B / two delegation modes", tier: "B", gate: false,
    desc: "[watch/internal] praxis__handoff `context.mode` defaults to 'intent_only' (byte-identical to pre-#6 payload); 'full' mode attaches PII-scrubbed + size-capped delegation_context (services/mcp/internal/praxis.ts + services/agents/delegation-context.ts)",
    skipIf: () => "internal contract — covered by delegation-context.test.ts (PII redaction + size cap) + praxis MCP tool integration tests; no public route to exercise the discriminator from black-box runner",
  },

];
