const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const inbox = loadTs(path.join(__dirname, "../src/features/channels/ugcInbox.ts"), {});
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));

const job = (o = {}) => ({
  id: "j1",
  source: "booking",
  status: "in_progress",
  closed_reason: null,
  title: "Spring ad",
  creator_display_name: "Maya Films",
  human_member_id: "m1",
  created_at: "2026-10-01T00:00:00Z",
  due_at: null,
  closed_at: null,
  money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%" },
  deadline: null,
  awaiting_creator: false,
  ...o,
});
const thread = (o = {}) => ({
  thread_id: "t1",
  human_member_id: "m1",
  display_name: "Maya Films",
  last_message: { body: "Hi there", sender_kind: "creator", created_at: "2026-10-03T10:00:00Z" },
  last_message_at: "2026-10-03T10:00:00Z",
  unread_count: 1,
  ...o,
});
const notice = (o = {}) => ({ id: "n1", link_path: "/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1", read_at: null, ...o });

test("a job card in web's words: title, total, status, creator and source, money line, deadline verbatim", () => {
  const line = "Deadline: 05 Oct 2026 at 14:00 UTC. If Maya doesn't accept by then, the booking is cancelled.";
  const r = plain(inbox.jobListRow(job({ status: "awaiting_acceptance", deadline: { line, kind: "accept", deadline_at: "2026-10-05T14:00:00Z" } })));
  eq(r, {
    id: "j1",
    title: "Spring ad",
    total: "$165.00",
    status: "Waiting for the creator",
    tone: "info",
    sub: "Maya Films · Booked package",
    moneyLine: "$150.00 to the creator plus $15.00 Zavi fee (10%).",
    deadline: line,
  });
});

test("source labels: hired from a brief, custom offer, booked package", () => {
  assert.equal(inbox.jobListRow(job({ source: "applicant" })).sub, "Maya Films · Hired from a brief");
  assert.equal(inbox.jobListRow(job({ source: "offer" })).sub, "Maya Films · Custom offer");
  assert.equal(inbox.jobListRow(job({ source: undefined, creator_display_name: null })).sub, "Booked package");
  assert.equal(inbox.jobListRow(job({ title: "" })).title, "Creator job");
});

test("the money line is never worked out: without the server's price and fee there is none", () => {
  const m = { currency: "usd", business_total_cents: 16500, business_fee_label: "10%" };
  const r = inbox.jobListRow(job({ money: m }));
  assert.equal(r.moneyLine, null);
  assert.equal(r.total, "$165.00");
  assert.equal(inbox.jobListRow(job({ money: { ...m, price_cents: 15000 } })).moneyLine, null);
  assert.equal(inbox.jobListRow(job({ money: { ...job().money, currency: "eur" } })).total, "EUR 165.00");
});

test("status chips and tones follow web's Jobs list", () => {
  const tone = (status, extra = {}) => {
    const r = inbox.jobListRow(job({ status, ...extra }));
    return [r.status, r.tone];
  };
  eq(tone("in_progress"), ["In progress", "info"]);
  eq(tone("submitted"), ["Ready for your review", "warn"]);
  eq(tone("revision_requested"), ["Changes requested", "warn"]);
  eq(tone("cancel_requested"), ["Cancellation requested", "warn"]);
  eq(tone("in_dispute"), ["Zavi is stepping in", "bad"]);
  eq(tone("completed", { closed_reason: "approved" }), ["Done", "ok"]);
  eq(tone("cancelled", { closed_reason: "declined" }), ["Cancelled", "neutral"]);
  eq(tone("something_new"), ["something new", "neutral"]);
  assert.equal(inbox.jobListRow(job({ deadline: null })).deadline, null);
});

test("notification links: a /workspace drawer link and its values, else nothing", () => {
  eq(inbox.drawerOfLink("/workspace?tab=channels&channel=ugc&drawer=job&job=j%201"), {
    name: "job",
    params: { tab: "channels", channel: "ugc", job: "j 1" },
  });
  assert.equal(inbox.drawerOfLink("https://www.zaviagent.com/workspace?drawer=thread&creator=m1").params.creator, "m1");
  assert.equal(inbox.drawerOfLink("/humans/jobs?drawer=job&job=j1"), null);
  assert.equal(inbox.drawerOfLink("/workspace?drawer=nope&job=j1"), null);
  assert.equal(inbox.drawerOfLink("/workspace?tab=channels"), null);
  assert.equal(inbox.drawerOfLink(null), null);
});

test("one entry per creator from threads and paid jobs; never-paid orders are no job", () => {
  const out = inbox.buildCreatorInbox(
    [thread()],
    [job(), job({ id: "j2", status: "checkout_pending" }), job({ id: "j3", status: "cancelled", closed_reason: "checkout_abandoned" }), job({ id: "j4", human_member_id: "m2", creator_display_name: null })],
    [],
  );
  eq(
    out.map((e) => [e.memberId, e.name, e.jobs.map((j) => j.job.id)]),
    [
      ["m1", "Maya Films", ["j1"]],
      ["m2", "Creator", ["j4"]],
    ],
  );
  const m1 = out.find((e) => e.memberId === "m1");
  assert.equal(m1.thread.thread_id, "t1");
  assert.equal(m1.lastAt, "2026-10-03T10:00:00Z");
});

test("a job's creator name fills a nameless thread; a missing name is 'Creator'", () => {
  const out = inbox.buildCreatorInbox([thread({ display_name: "" })], [job({ creator_display_name: "Maya Films" })], []);
  assert.equal(out[0].name, "Maya Films");
  assert.equal(inbox.buildCreatorInbox([thread({ display_name: "" })], [], [])[0].name, "Creator");
});

test("jobs per creator: open ones first, then finished, each newest booking first", () => {
  const out = inbox.buildCreatorInbox(
    [],
    [
      job({ id: "old-done", status: "completed", closed_reason: "approved", created_at: "2026-09-01T00:00:00Z", closed_at: "2026-09-10T00:00:00Z" }),
      job({ id: "old-open", created_at: "2026-09-02T00:00:00Z" }),
      job({ id: "new-done", status: "cancelled", closed_reason: "declined", created_at: "2026-10-02T00:00:00Z", closed_at: "2026-10-02T00:00:00Z" }),
      job({ id: "new-open", status: "revision_requested", created_at: "2026-10-03T00:00:00Z" }),
    ],
    [],
  );
  eq(out[0].jobs.map((j) => j.job.id), ["new-open", "old-open", "new-done", "old-done"]);
});

test("entries: needing you first, then newest activity first", () => {
  const out = inbox.buildCreatorInbox(
    [
      thread({ human_member_id: "quiet-new", display_name: "Quiet New", last_message_at: "2026-10-06T00:00:00Z" }),
      thread({ human_member_id: "quiet-old", display_name: "Quiet Old", last_message_at: "2026-09-06T00:00:00Z" }),
    ],
    [job({ id: "jx", human_member_id: "busy", creator_display_name: "Busy", status: "submitted", created_at: "2026-08-01T00:00:00Z" })],
    [],
  );
  eq(out.map((e) => e.memberId), ["busy", "quiet-new", "quiet-old"]);
  assert.equal(out[0].needsYou, true);
  assert.equal(out[1].needsYou, false);
});

test("needs you: an unread notice, or a job in an action state that is not done", () => {
  const needs = (j, n = []) => inbox.buildCreatorInbox([], [job(j)], n)[0].needsYou;
  assert.equal(needs({ status: "awaiting_acceptance" }), true);
  assert.equal(needs({ status: "submitted" }), true);
  assert.equal(needs({ status: "in_progress", product_needed: true, product_received_at: null }), true);
  assert.equal(needs({ status: "in_progress" }), false);
  assert.equal(needs({ status: "completed", closed_reason: "approved" }), false);
  assert.equal(needs({ status: "in_progress" }, [notice({ link_path: "/workspace?drawer=job&job=j1" })]), true);
});

test("unread notices land on the creator they name, or on the creator of the job they name; read ones never", () => {
  const out = inbox.buildCreatorInbox(
    [thread()],
    [job({ id: "j9", human_member_id: "m2", creator_display_name: "Sam" })],
    [
      notice({ id: "n-thread" }),
      notice({ id: "n-job", link_path: "/workspace?tab=channels&channel=ugc&drawer=job&job=j9" }),
      notice({ id: "n-read", read_at: "2026-10-05T00:00:00Z" }),
      notice({ id: "n-nolink", link_path: null }),
      notice({ id: "n-stranger", link_path: "/workspace?drawer=thread&creator=nobody" }),
      notice({ id: "n-unknown-job", link_path: "/workspace?drawer=job&job=zzz" }),
    ],
  );
  const by = Object.fromEntries(out.map((e) => [e.memberId, e.unread]));
  eq(by, { m1: ["n-thread"], m2: ["n-job"] });
});

test("filters and their live counts: All, Needs you, Working, Finished work (completed only)", () => {
  const out = inbox.buildCreatorInbox(
    [thread({ human_member_id: "talk", display_name: "Talk Only" })],
    [
      job({ id: "a", human_member_id: "work", creator_display_name: "Worker" }),
      job({ id: "b", human_member_id: "done", creator_display_name: "Done", status: "completed", closed_reason: "approved", closed_at: "2026-10-02T00:00:00Z" }),
      job({ id: "c", human_member_id: "gone", creator_display_name: "Gone", status: "cancelled", closed_reason: "declined" }),
      job({ id: "d", human_member_id: "rev", creator_display_name: "Rev", status: "submitted" }),
    ],
    [],
  );
  eq(inbox.filterCounts(out), { all: 5, needs_you: 1, working: 2, finished: 1 });
  eq(out.filter((e) => inbox.inboxMatches(e, "finished")).map((e) => e.memberId), ["done"]);
  eq(inbox.INBOX_FILTERS.map((f) => f.label), ["All", "Needs you", "Working", "Finished work"]);
});

test("the screen: loading, the failed-read banner over what loaded, empty, filter-empty, list", () => {
  assert.equal(inbox.inboxScreen(null, null, "all").kind, "loading");
  eq(inbox.inboxScreen(null, "Could not load your messages just now.", "all"), {
    kind: "empty",
    banner: "Some of this did not load: Could not load your messages just now.",
    text: null,
  });
  eq(inbox.inboxScreen([], null, "all"), {
    kind: "empty",
    banner: null,
    text: "No creators yet. Message or book one from Find creators and they show here.",
  });
  const entries = inbox.buildCreatorInbox([thread()], [], []);
  assert.equal(inbox.inboxScreen(entries, null, "working").text, "Nobody in this view right now.");
  const kept = inbox.inboxScreen(entries, "Zavi could not finish that.", "all");
  assert.equal(kept.kind, "list");
  assert.equal(kept.shown.length, 1);
  assert.equal(kept.banner, "Some of this did not load: Zavi could not finish that.");
});

test("card words: jobs sub line, last message with who and when, review target", () => {
  const now = new Date(2026, 9, 3, 18, 0);
  const local = (y, m, d, h, min) => new Date(y, m, d, h, min).toISOString();
  const entries = inbox.buildCreatorInbox(
    [thread({ last_message: { body: "Sent it!", sender_kind: "creator", created_at: local(2026, 9, 3, 15, 4) } })],
    [
      job({ id: "s", status: "submitted", created_at: "2026-10-02T00:00:00Z" }),
      job({ id: "c", status: "completed", closed_reason: "approved", created_at: "2026-09-02T00:00:00Z" }),
    ],
    [],
  );
  const e = entries[0];
  assert.equal(inbox.inboxSubLine(e), "2 jobs · 1 finished");
  assert.equal(inbox.inboxSubLine({ jobs: [] }), "No jobs yet");
  assert.equal(inbox.inboxSubLine({ jobs: [e.jobs[0]] }), "1 job");
  eq(inbox.lastMessage(e, now), { who: "Maya:", body: "Sent it!", stamp: "3:04 PM" });
  const mine = { name: "Maya Films", thread: thread({ last_message: { body: "Thanks", sender_kind: "tenant", created_at: local(2026, 8, 24, 9, 0) } }) };
  eq(inbox.lastMessage(mine, now), { who: "You:", body: "Thanks", stamp: "Sep 24" });
  assert.equal(inbox.lastMessage({ name: "Maya", thread: null }, now), null);
  assert.equal(inbox.lastMessage({ name: "Maya", thread: thread({ last_message: null }) }, now), null);
  assert.equal(inbox.reviewJob(e).job.id, "s");
  assert.equal(inbox.reviewJob({ jobs: [e.jobs[1]] }), null);
});

test("stamps are built by hand: 12-hour time today, else month and day", () => {
  const now = new Date(2026, 9, 3, 23, 0);
  const at = (h, m) => new Date(2026, 9, 3, h, m).toISOString();
  assert.equal(inbox.messageStamp(at(0, 5), now), "12:05 AM");
  assert.equal(inbox.messageStamp(at(12, 0), now), "12:00 PM");
  assert.equal(inbox.messageStamp(at(23, 59), now), "11:59 PM");
  assert.equal(inbox.messageStamp(new Date(2026, 0, 2, 10, 0).toISOString(), now), "Jan 2");
  assert.equal(inbox.messageStamp("nope", now), "");
  assert.equal(inbox.messageStamp(null, now), "");
});

test("lane tones as chip tones: open green, action amber, quiet grey", () => {
  assert.equal(inbox.laneTone("open"), "ok");
  assert.equal(inbox.laneTone("action"), "warn");
  assert.equal(inbox.laneTone("quiet"), "neutral");
});

test("invite ids: the uuid behind invite:, and its messages path", () => {
  assert.equal(inbox.inviteUuidOf("invite:4f1c"), "4f1c");
  assert.equal(inbox.inviteUuidOf("4f1c"), null);
  assert.equal(inbox.inviteUuidOf("invite:"), null);
  assert.equal(inbox.inviteMessagesPath("invite:a/b"), "/api/creators/invites/a%2Fb/messages");
  assert.equal(inbox.inviteMessagesPath("m1"), null);
});

test("thread words: 'the creator' while the name is unknown, never 'the'", () => {
  assert.equal(inbox.threadFirst(null), "the creator");
  assert.equal(inbox.threadFirst("  "), "the creator");
  assert.equal(inbox.threadFirst("Maya Films"), "Maya");
  assert.equal(inbox.threadInfoLine(false, "Maya"), "Each new message or offer emails the other side, at most one email per conversation every 15 minutes.");
  assert.equal(
    inbox.threadInfoLine(true, "Maya"),
    "Maya is not on Zavi yet. Your first message sends them an email to join and read it; later ones wait until they do.",
  );
  assert.equal(inbox.threadEmptyLine(false, "Maya"), "No messages with Maya yet. Say hello, or send a custom offer below.");
  assert.equal(inbox.threadEmptyLine(true, "the creator"), "No messages with the creator yet. Say hello: they get an email to join and read it.");
  assert.equal(inbox.inviteOffersNote("Maya"), "Custom offers and booking open once Maya joins Zavi. This conversation moves with them when they do.");
});

function loadHooks(data = {}) {
  const calls = [];
  const invalidated = [];
  const q = (d, extra = {}) => ({ data: d, isError: false, error: null, isRefetching: false, refetch: () => calls.push({ refetch: true }), ...extra });
  const hooks = loadTs(path.join(__dirname, "../src/features/channels/ugcInboxHooks.ts"), {
    "@tanstack/react-query": {
      useQuery: (o) => o,
      useMutation: (o) => o,
      useQueryClient: () => ({ invalidateQueries: (x) => invalidated.push(x) }),
    },
    "../../lib/api": {
      apiJson: (p, opts) => {
        calls.push({ path: p, opts: opts ?? null });
        return Promise.resolve({ messages: [{ id: "x", sender_kind: "tenant", body: "Hi", created_at: "2026-10-01T00:00:00Z" }], email_note: "Maya gets an email." });
      },
    },
    "../workspaces/useActiveTenant": { useActiveTenant: () => "t1" },
    "./ugcHooks": {
      ugcKey: (tenant, ...rest) => ["ugc", tenant, ...rest],
      useThreads: () => data.threads ?? q([thread()]),
      useJobs: () => data.jobs ?? q([job()]),
      useNotices: () => data.notices ?? q({ notifications: [notice()], unread: 1 }),
    },
  });
  return { hooks, calls, invalidated, q };
}

test("invite messages: read by the invite uuid in the path, keyed per workspace, off for a member", async () => {
  const { hooks, calls } = loadHooks();
  const r = hooks.useInviteMessages("invite:u1");
  eq(r.queryKey, ["ugc", "t1", "invite-messages", "u1"]);
  assert.equal(r.enabled, true);
  const msgs = await r.queryFn();
  assert.equal(calls[0].path, "/api/creators/invites/u1/messages");
  assert.equal(calls[0].opts, null);
  assert.equal(msgs.length, 1);
  assert.equal(hooks.useInviteMessages("m1").enabled, false);
});

test("send to an invitee: one POST of the body, not replayed, answering the server's email note", async () => {
  const { hooks, calls, invalidated } = loadHooks();
  const m = hooks.useSendInviteMessage();
  const out = await m.mutationFn({ memberId: "invite:u1", body: "Hello" });
  assert.equal(calls[0].path, "/api/creators/invites/u1/messages");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.retryOnNetworkError, false);
  assert.equal(calls[0].opts.idempotent, undefined);
  eq(JSON.parse(calls[0].opts.body), { body: "Hello" });
  assert.equal(out.email_note, "Maya gets an email.");
  m.onSuccess();
  eq(invalidated, [{ queryKey: ["ugc", "t1"] }]);
  await assert.rejects(() => m.mutationFn({ memberId: "m1", body: "x" }));
});

test("the inbox needs both threads and jobs; a failed read is said, jobs' message first", () => {
  const ok = loadHooks().hooks.useCreatorInbox();
  assert.equal(ok.error, null);
  assert.equal(ok.entries.length, 1);
  eq(ok.entries[0].unread, ["n1"]);

  const { q } = loadHooks();
  const failingJobs = loadHooks({ jobs: q(undefined, { isError: true, error: new Error("Zavi could not finish that.") }), threads: q(undefined, { isError: true, error: new Error("Could not load your messages just now.") }) });
  const bad = failingJobs.hooks.useCreatorInbox();
  assert.equal(bad.entries, null);
  assert.equal(bad.error, "Zavi could not finish that.");
  const threadsOnly = loadHooks({ threads: q(undefined, { isError: true, error: new Error("Could not load your messages just now.") }) }).hooks.useCreatorInbox();
  assert.equal(threadsOnly.entries, null);
  assert.equal(threadsOnly.error, "Could not load your messages just now.");

  const quiet = loadHooks({ notices: q(undefined, { isError: true, error: new Error("Notifications did not load.") }) }).hooks.useCreatorInbox();
  assert.equal(quiet.error, null);
  eq(quiet.entries[0].unread, []);
});
