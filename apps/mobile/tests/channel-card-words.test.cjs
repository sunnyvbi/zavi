const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadDisplay() {
  const file = path.join(__dirname, "..", "src/features/channels/display.ts");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name === "@zavi/shared") {
          return { getChannel: (slug) => ({ name: slug.toUpperCase() }), socialLimit: () => null, PHONE_APPROVE_EXEC: new Set(["seo.create_pr.v1", "geo.create_pr.v1", "generated_video.render.v1"]), EMAIL_SEND_EXEC: "email_campaign.create_and_send" };
        }
        if (name === "./channelList") return { CHANNEL_ORDER: [] };
        if (name === "./cardCopy") return { cardCopy: () => null };
        throw new Error(`Unexpected dependency: ${name}`);
      },
    },
    { filename: "display.ts" },
  );
  return module.exports;
}

const { toChannelAction } = loadDisplay();

function row(extra) {
  return {
    id: "a-1",
    decision_class: "channel.recipe_step",
    status: "pending",
    action_source: "channel_action",
    channel_slug: "ugc",
    body: {
      step: {
        title: "Email three creators",
        body: "They already post about this.",
        deliverable: { kind: "email", label: "Collab idea", content: "Hi there" },
      },
    },
    ...extra,
  };
}

test("stored card words are carried as-is", () => {
  const a = toChannelAction(
    row({
      card_kind: "message",
      primary_label: "Open email",
      done_label: "I sent it",
      how_to: ["Press Open email.", "Pick the person."],
      steps_done: [1],
    }),
  );
  assert.equal(a.status, "pending");
  assert.equal(toChannelAction(row({ status: "rejected" })).status, "rejected");
  assert.equal(a.cardKind, "message");
  assert.equal(a.primaryLabel, "Open email");
  assert.equal(a.doneLabel, "I sent it");
  assert.deepEqual([...a.howTo], ["Press Open email.", "Pick the person."]);
  assert.deepEqual([...a.stepsDone], [1]);
  assert.equal(a.deliverableLabel, "Collab idea");
});

test("a row without card words maps to null and empty, the old card", () => {
  const a = toChannelAction(row({}));
  assert.equal(a.cardKind, null);
  assert.equal(a.primaryLabel, null);
  assert.equal(a.doneLabel, null);
  assert.deepEqual([...a.howTo], []);
  assert.deepEqual([...a.stepsDone], []);
});

test("an unknown kind or a missing label falls back to the old card, never a blank button", () => {
  for (const extra of [
    { card_kind: "hologram", primary_label: "Beam it", done_label: "Beamed" },
    { card_kind: "task", primary_label: "Show steps", done_label: null },
    { card_kind: "task", primary_label: "  ", done_label: "Done" },
  ]) {
    const a = toChannelAction(row(extra));
    assert.equal(a.cardKind, null);
    assert.equal(a.primaryLabel, null);
    assert.equal(a.doneLabel, null);
  }
});

test("how_to and steps_done keep only well-formed entries", () => {
  const a = toChannelAction(
    row({
      card_kind: "task",
      primary_label: "Show steps",
      done_label: "Done",
      how_to: ["Open it.", 3, "", null, "Check it."],
      steps_done: [0, 1.5, "2", 2],
    }),
  );
  assert.deepEqual([...a.howTo], ["Open it.", "Check it."]);
  assert.deepEqual([...a.stepsDone], [0, 2]);
});

test("the card's own https link is carried for an Open task; anything else is dropped", () => {
  const withLink = (link) => toChannelAction(row({ body: { ...row({}).body, link } }));
  assert.equal(withLink("https://www.reddit.com/r/x/").link, "https://www.reddit.com/r/x/");
  assert.equal(withLink("http://example.com/").link, null);
  assert.equal(withLink("javascript:alert(1)").link, null);
  assert.equal(withLink(undefined).link, null);
});

test("an executable row is flagged even before it has stored words", () => {
  assert.equal(toChannelAction(row({ exec_class: "google_ads.set_status" })).executable, true);
  assert.equal(toChannelAction(row({})).executable, false);
});

test("a backend lane title keeps an otherwise terse channel action visible", () => {
  const a = toChannelAction(
    row({
      title: "Pause the costly keywords",
      body: { action_label: "Pause" },
    }),
  );
  assert.equal(a.title, "Pause the costly keywords");
  assert.equal(a.text, "");
});

test("a row with no body text and no card title still drops", () => {
  assert.equal(toChannelAction(row({ body: {} })), null);
});

test("the executed receipt is carried, its link only when https", () => {
  const a = toChannelAction(row({ exec_receipt: { line: "Opened PR #12", url: "https://github.com/acme/site/pull/12" } }));
  assert.deepEqual({ ...a.execReceipt }, { line: "Opened PR #12", url: "https://github.com/acme/site/pull/12" });
  assert.deepEqual({ ...toChannelAction(row({ exec_receipt: { line: "Sent", url: "javascript:x" } })).execReceipt }, { line: "Sent", url: null });
  assert.equal(toChannelAction(row({ exec_receipt: { line: "  " } })).execReceipt, null);
  assert.equal(toChannelAction(row({})).execReceipt, null);
});

test("the server flag makes a card phone-approvable (a decisions row only for pull requests and videos); an email send opens its email card", () => {
  assert.equal(toChannelAction(row({ approve_on_phone: true })).approveOnPhone, true);
  assert.equal(toChannelAction(row({ exec_class: "seo.create_pr.v1" })).approveOnPhone, true);
  assert.equal(toChannelAction(row({ exec_class: "generated_video.render.v1" })).approveOnPhone, true);
  assert.equal(toChannelAction(row({ exec_class: "meta_ads.set_status" })).approveOnPhone, false);
  assert.equal(toChannelAction(row({ exec_class: "email_campaign.create_and_send" })).approveOnPhone, false);
  assert.equal(toChannelAction(row({ exec_class: "email_campaign.create_and_send" })).emailCard, true);
  assert.equal(toChannelAction(row({ email_card: true })).emailCard, true);
  assert.equal(toChannelAction(row({})).emailCard, false);
});

test("an ad card carries who may approve it, its dollars and its exact-change rows for the phone's confirm", () => {
  const rows = [{ item: "Daily budget", before: "$20/day", after: "$40/day" }];
  const a = toChannelAction(row({ approve_on_phone: true, approve_needs_admin: true, approve_money: { daily_usd: 20, monthly_usd: 608 }, body: { step: { title: "Raise it", body: "x" }, exact_change: { rows: [...rows, { item: 1 }] } } }));
  assert.equal(a.approveNeedsAdmin, true);
  assert.deepEqual({ ...a.approveMoney }, { daily_usd: 20, monthly_usd: 608 });
  assert.deepEqual(a.changeRows.map((r) => ({ ...r })), rows);
  const b = toChannelAction(row({ approve_money: { daily_usd: -1, monthly_usd: 3 } }));
  assert.equal(b.approveMoney, null);
  assert.equal(b.approveNeedsAdmin, null);
  assert.deepEqual([...b.changeRows], []);
});

test("money keeps day and month when present; numeric exact-change cells are kept as text", () => {
  const a = toChannelAction(row({ approve_money: { daily_usd: 5, monthly_usd: 152, total_usd: "x" }, body: { step: { title: "t", body: "x" }, exact_change: { rows: [{ item: "Daily budget", before: 20, after: 40 }] } } }));
  assert.deepEqual({ ...a.approveMoney }, { daily_usd: 5, monthly_usd: 152 });
  assert.deepEqual(a.changeRows.map((r) => ({ ...r })), [{ item: "Daily budget", before: "20", after: "40" }]);
  assert.equal(toChannelAction(row({ approve_on_phone: true, approve_needs_admin: false })).approveNeedsAdmin, false);
});
