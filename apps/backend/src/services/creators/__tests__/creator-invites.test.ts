
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: { creator_invites: [] as Record<string, unknown>[], human_members: [] as Record<string, unknown>[] } as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
  afterRead: null as null | (() => void),
}));

function builder(table: string, mode: "select" | "insert" | "update" | "delete", payload?: unknown) {
  const filters: ((r: Row) => boolean)[] = [];
  let range: [number, number] | null = null;
  const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (mode === "insert") {
      for (const r of payload as Row[]) db.tables[table].push({ id: `id-${db.tables[table].length + 1}`, ...r });
      return { data: payload, error: null };
    }
    if (mode === "update") {
      const hit = rows();
      for (const r of hit) Object.assign(r, payload as Row);
      return { data: hit, error: null };
    }
    if (mode === "delete") {
      const hit = rows();
      db.tables[table] = db.tables[table].filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    const all = rows();
    const page = (range ? all.slice(range[0], range[1] + 1) : all).map((r) => ({ ...r }));
    return { data: page, error: null, count: all.length };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    is: (c: string, v: unknown) => (filters.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
    not: (c: string) => (filters.push((r) => r[c] != null), b),
    range: (a: number, z: number) => {
      range = [a, z];
      const out = run();
      db.afterRead?.();
      return Promise.resolve(out);
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({
    from: (table: string) => ({
      select: () => builder(table, "select"),
      insert: (rows: Row[]) => builder(table, "insert", rows),
      update: (v: Row) => builder(table, "update", v),
      delete: () => builder(table, "delete"),
    }),
  }),
  creatorInviteRpc: (...a: unknown[]) => db.rpc(...a),
}));

import {
  classifySendError,
  eligibleRows,
  formatListedInvite,
  inviteLinkBases,
  isPublicHttpsBase,
  missingEmailCsv,
  pickFirstInvitable,
  ineligibleReason,
  isEuUkDomain,
  isInConversation,
  normalizeEmail,
  parseCreatorSheet,
  parseFollowers,
  parseRowList,
  sendPreflight,
  sheetDuplicateOf,
  upsertFromSheet,
  type InviteRow,
  type SheetRow,
} from "../creator-invites";

const SHEET = readFileSync(join(__dirname, "fixtures", "creator-sheet.csv"), "utf8");

beforeEach(() => {
  db.tables.creator_invites = [];
  db.tables.human_members = [];
  db.afterRead = null;
  db.rpc.mockReset();
  db.rpc.mockResolvedValue({ data: [], error: null });
});

describe("parse helpers", () => {
  it("reads the follower formats the sheet uses", () => {
    expect(parseFollowers("12K")).toBe(12_000);
    expect(parseFollowers("3.8 M")).toBe(3_800_000);
    expect(parseFollowers("23K+")).toBe(23_000);
    expect(parseFollowers("179,000")).toBe(179_000);
    expect(parseFollowers("944000")).toBe(944_000);
    expect(parseFollowers("99.9 K")).toBe(99_900);
    for (const junk of ["1k-10k", "0–1k", "Not found", "Not verified", ""]) expect(parseFollowers(junk)).toBeNull();
  });

  it("accepts only real email addresses, lowercased", () => {
    expect(normalizeEmail(" Ada@Ada.Example ")).toBe("ada@ada.example");
    for (const junk of ["Not verified", "Not found", "", "a@b", "two@a.com, b@c.com"]) expect(normalizeEmail(junk)).toBeNull();
  });

  it("classifies conversation, EU/UK domains and the sheet's duplicate notes", () => {
    expect(isInConversation("Sent", "Not contacted")).toBe(true);
    expect(isInConversation("No outreach recorded", "Awaiting reply — follow-up sent")).toBe(true);
    expect(isInConversation("No outreach recorded", "No reply recorded")).toBe(false);
    expect(isEuUkDomain("studio.co.uk")).toBe(true);
    expect(isEuUkDomain("hal.de")).toBe(true);
    expect(isEuUkDomain("ada.com")).toBe(false);
    expect(sheetDuplicateOf("Duplicate of row 79; same creator.")).toBe(79);
    expect(sheetDuplicateOf("Canonical row for row 116.")).toBeNull();
  });
});

describe("parseCreatorSheet on the synthetic sheet", () => {
  const { rows, report } = parseCreatorSheet(SHEET);
  const by = (name: string) => rows.filter((r) => r.displayName === name);
  const one = (name: string) => {
    const hit = by(name);
    expect(hit).toHaveLength(1);
    return hit[0];
  };

  it("reports every drop by sheet row number", () => {
    expect(report.rowsRead).toBe(18);
    expect(report.blankRows).toBe(1);
    expect(report.sheetDuplicates).toEqual([12]);
    expect(report.sameEmailDuplicates).toEqual([15]);
    expect(report.duplicateReview).toEqual([14]);
    expect(report.sourceKeyDuplicates).toEqual([17]);
    expect(report.sharedDomains).toEqual(["sharedco.example"]);
    expect(rows).toHaveLength(15);
  });

  it("an untouched creator is invitable, with parsed profiles and followers", () => {
    const ada = one("Ada Fresh");
    expect(ada.holdReason).toBeNull();
    expect(ada.inConversation).toBe(false);
    expect(ada.sheetRow).toBe(2);
    expect(ada.profiles.instagram).toEqual({ url: "https://www.instagram.com/ada.makes/", handle: "ada.makes" });
    expect(ada.followers.instagram).toEqual({ raw: "12K", n: 12_000 });
    expect(ada.followers.x).toEqual({ raw: "1k-10k", n: null });
    expect(ada.sourceMeta).toEqual({ sheet_row: 2, outreach_status: "No outreach recorded", reply_status: "No reply recorded", source_host: "collabstr.com" });
  });

  it("holds every row that must never be invited", () => {
    expect(one("Bea Talking")).toMatchObject({ holdReason: null, inConversation: true });
    expect(one("Cy Bounce").holdReason).toBe("prior_bounce");
    expect(one("Di Declined").holdReason).toBe("prior_declined");
    expect(one("Ed Agency").holdReason).toBe("agency");
    expect(one("Fi Shared").holdReason).toBe("agency");
    expect(one("Gus Shared").holdReason).toBe("agency");
    expect(one("Hal Euro").holdReason).toBe("eu_domain");
    expect(one("Ivy NoEmail")).toMatchObject({ holdReason: "no_email", email: null });
  });

  it("the survivor of a sheet-marked duplicate keeps the duplicate's bounce", () => {
    const jo = one("Jo Canonical");
    expect(jo.sheetRow).toBe(11);
    expect(jo.holdReason).toBe("prior_bounce");
  });

  it("a shared inbox loads the second creator with no email, held for review", () => {
    expect(one("Kim Inbox")).toMatchObject({ email: "kim@kim.example", holdReason: null });
    expect(one("Lee Inbox")).toMatchObject({ email: null, holdReason: "duplicate_review" });
  });

  it("keeps a multi-line cell inside its row, keeps /channel/ URLs, reads a social Source URL", () => {
    const nia = one("Nia Multiline");
    expect(nia.email).toBe("nia@nia.example");
    expect(nia.profiles.youtube).toEqual({ url: "https://www.youtube.com/channel/UCabc123", handle: null });
    expect(nia.followers.youtube).toEqual({ raw: "179,000", n: 179_000 });
    const oz = one("Oz Source");
    expect(oz.profiles.x).toEqual({ url: "https://x.com/oz_makes", handle: "oz_makes" });
    expect(oz.followers.x?.n).toBe(3_800_000);
  });

  it("--exclude-domains adds agencies", () => {
    const out = parseCreatorSheet(SHEET, { excludeDomains: ["ada.example"] });
    expect(out.rows.find((r) => r.displayName === "Ada Fresh")?.holdReason).toBe("agency");
  });

  it("refuses a CSV that is missing a required column", () => {
    expect(() => parseCreatorSheet("Creator,Email\nA,a@a.example\n")).toThrow(/missing columns/);
  });
});

const sheetRow = (over: Partial<SheetRow>): SheetRow => ({
  sheetRow: 2,
  sourceKey: "ada|collabstr.com/ada",
  displayName: "Ada",
  email: "ada@ada.example",
  profiles: {},
  followers: {},
  sourceMeta: { sheet_row: 2, outreach_status: "", reply_status: "", source_host: null },
  inConversation: false,
  holdReason: null,
  ...over,
});

describe("upsertFromSheet", () => {
  it("dry run writes nothing", async () => {
    const out = await upsertFromSheet([sheetRow({})], "b1", false);
    expect(out.inserted).toBe(1);
    expect(db.tables.creator_invites).toHaveLength(0);
  });

  it("inserts, then a re-import refreshes without touching history, batch or the stored email", async () => {
    await upsertFromSheet([sheetRow({})], "b1", true);
    const stored = db.tables.creator_invites[0];
    Object.assign(stored, { invited_at: "2026-09-29T00:00:00Z", hold_reason: "prior_bounce" });

    const out = await upsertFromSheet([sheetRow({ email: "new@ada.example", displayName: "Ada R", holdReason: null })], "b2", true);
    expect(out).toMatchObject({ inserted: 0, updated: 1, emailConflicts: [2] });
    expect(stored).toMatchObject({
      email: "ada@ada.example",
      batch: "b1",
      invited_at: "2026-09-29T00:00:00Z",
      display_name: "Ada R",
      hold_reason: "prior_bounce",
    });
  });

  it("a stored email that the sheet changes is held as email_conflict", async () => {
    await upsertFromSheet([sheetRow({})], "b1", true);
    await upsertFromSheet([sheetRow({ email: "other@ada.example" })], "b1", true);
    expect(db.tables.creator_invites[0]).toMatchObject({ email: "ada@ada.example", hold_reason: "email_conflict" });
  });

  it("fills an email found later, unless another row already holds it", async () => {
    await upsertFromSheet(
      [sheetRow({ email: null, holdReason: "no_email" }), sheetRow({ sheetRow: 3, sourceKey: "bea|x", displayName: "Bea", email: "bea@bea.example" })],
      "b1",
      true,
    );
    await upsertFromSheet([sheetRow({ email: "ada@ada.example", holdReason: null })], "b1", true);
    expect(db.tables.creator_invites[0]).toMatchObject({ email: "ada@ada.example", hold_reason: null });

    await upsertFromSheet([sheetRow({ sourceKey: "cy|x", sheetRow: 4, displayName: "Cy", email: "bea@bea.example" })], "b1", true);
    const cy = db.tables.creator_invites.find((r) => r.source_key === "cy|x");
    expect(cy).toMatchObject({ email: null, hold_reason: "email_conflict" });
  });

  it("never refills a deleted creator's stub", async () => {
    await upsertFromSheet([sheetRow({})], "b1", true);
    Object.assign(db.tables.creator_invites[0], { member_deleted_at: "2026-09-29T00:00:00Z", display_name: "(deleted)" });
    const out = await upsertFromSheet([sheetRow({ displayName: "Ada Again" })], "b1", true);
    expect(out.skippedDeleted).toEqual([2]);
    expect(db.tables.creator_invites[0].display_name).toBe("(deleted)");
  });
});

const invite = (over: Partial<InviteRow>): InviteRow => ({
  id: "i1",
  source_key: "k",
  email: "ada@ada.example",
  display_name: "Ada",
  hold_reason: null,
  in_conversation: false,
  batch: "b1",
  unsub_token: "00000000-0000-4000-8000-000000000000",
  invited_at: null,
  send_failed_at: null,
  unsubscribed_at: null,
  bounced_at: null,
  human_member_id: null,
  claimed_at: null,
  member_deleted_at: null,
  source_meta: { sheet_row: 2 },
  ...over,
});

describe("who can be sent", () => {
  it("ONE email per creator: after signup (profile done or not) no mode ever sends again", () => {
    for (const signedUp of [
      invite({ invited_at: "t", human_member_id: "m1", claimed_at: "t" }),
      invite({ invited_at: "t", send_failed_at: "t", human_member_id: "m1", claimed_at: "t" }),
      invite({ claimed_at: "t" }),
    ]) {
      for (const mode of ["invite", "retry"] as const) {
        expect(ineligibleReason(signedUp, mode, true)).toMatch(/signed up/);
      }
    }
  });

  it("invite mode", () => {
    expect(ineligibleReason(invite({}), "invite", false)).toBeNull();
    expect(ineligibleReason(invite({ in_conversation: true }), "invite", false)).toMatch(/conversation/);
    expect(ineligibleReason(invite({ in_conversation: true }), "invite", true)).toBeNull();
    expect(ineligibleReason(invite({ hold_reason: "agency" }), "invite", true)).toMatch(/agency/);
    expect(ineligibleReason(invite({ invited_at: "t" }), "invite", false)).toMatch(/already invited/);
    expect(ineligibleReason(invite({ unsubscribed_at: "t" }), "invite", false)).toBe("unsubscribed");
    expect(ineligibleReason(invite({ bounced_at: "t" }), "invite", false)).toBe("bounced");
    expect(ineligibleReason(invite({ claimed_at: "t" }), "invite", false)).toMatch(/signed up/);
    expect(ineligibleReason(invite({ member_deleted_at: "t", claimed_at: "t" }), "invite", false)).toMatch(/deleted/);
    expect(ineligibleReason(invite({ email: null }), "invite", false)).toBe("no email");
  });

  it("retry mode only takes rows SendGrid rejected", () => {
    expect(ineligibleReason(invite({ invited_at: "t", send_failed_at: "t" }), "retry", false)).toBeNull();
    expect(ineligibleReason(invite({ invited_at: "t" }), "retry", false)).toMatch(/no failed invite/);
  });

  it("the send list is in sheet order and drops addresses that already have a Zavi account", async () => {
    db.tables.creator_invites = [
      { ...invite({ id: "c", email: "c@c.example", source_meta: { sheet_row: 9 } }) },
      { ...invite({ id: "a", email: "a@a.example", source_meta: { sheet_row: 3 } }) },
      { ...invite({ id: "b", email: "b@b.example", source_meta: { sheet_row: 5 } }) },
    ];
    db.rpc.mockResolvedValue({ data: [{ email: "b@b.example", kind: "account" }], error: null });
    const out = await eligibleRows({ batch: "b1", mode: "invite" });
    expect(out.candidates.map((r) => r.id)).toEqual(["a", "c"]);
    expect(out.skipped).toEqual([{ sheetRow: 5, name: "Ada", reason: "already has a Zavi account" }]);
    expect(db.rpc).toHaveBeenCalledWith("creator_invite_existing_accounts", { p_emails: ["a@a.example", "b@b.example", "c@c.example"] });
  });

  it("--rows sends exactly those rows and reports, never replaces, an ineligible one", async () => {
    db.tables.creator_invites = [
      { ...invite({ id: "a", source_meta: { sheet_row: 3 } }) },
      { ...invite({ id: "b", email: "b@b.example", invited_at: "t", source_meta: { sheet_row: 5 } }) },
      { ...invite({ id: "c", email: "c@c.example", source_meta: { sheet_row: 9 } }) },
    ];
    const out = await eligibleRows({ batch: "b1", mode: "invite", rows: [3, 5, 77] });
    expect(out.candidates.map((r) => r.id)).toEqual(["a"]);
    expect(out.skipped.map((s) => [s.sheetRow, s.reason])).toEqual([
      [5, "already invited"],
      [77, "no such row in this batch"],
    ]);
  });

  it("a failed account check stops the run instead of assuming 'no account'", async () => {
    db.tables.creator_invites = [{ ...invite({}) }];
    db.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(eligibleRows({ batch: "b1", mode: "invite" })).rejects.toThrow(/existing accounts/);
  });
});

const HEADER = SHEET.split(/\r?\n/)[0].split(",");
const mini = (rows: Record<string, string>[]) =>
  [HEADER.join(","), ...rows.map((r) => HEADER.map((h) => (r[h] ?? "").replace(/,/g, " ")).join(","))].join("\n");
const clean = { "Outreach status": "No outreach recorded", "Reply status": "No reply recorded" };

describe("flags travel across every linked row before anything is dropped", () => {
  it("a decline two duplicate-notes away still reaches the surviving row", () => {
    const { rows } = parseCreatorSheet(
      mini([
        { Creator: "Pat", Email: "pat@pat.example", ...clean, "Source URL": "https://collabstr.com/pat" },
        { Creator: "Pat", Email: "Not found", ...clean, "Identity / data check": "Duplicate of row 2", "Source URL": "https://collabstr.com/pat2" },
        { Creator: "Pat", Email: "Not found", "Outreach status": "Sent", "Reply status": "Declined", "Identity / data check": "Duplicate of row 3", "Source URL": "https://collabstr.com/pat3" },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].holdReason).toBe("prior_declined");
  });

  it("a same name + Source URL duplicate passes its decline to the row that has the email", () => {
    const { rows, report } = parseCreatorSheet(
      mini([
        { Creator: "Quin", Email: "quin@quin.example", ...clean, "Source URL": "https://collabstr.com/quin" },
        { Creator: "Quin", Email: "Not found", "Outreach status": "Sent", "Reply status": "Declined", "Source URL": "https://collabstr.com/quin/" },
      ]),
    );
    expect(report.sourceKeyDuplicates).toEqual([3]);
    expect(rows[0]).toMatchObject({ email: "quin@quin.example", holdReason: "prior_declined" });
  });
});

describe("re-import keeps holds tied to the stored address", () => {
  it("a sheet that loses the email keeps the stored address's EU hold", async () => {
    await upsertFromSheet([sheetRow({ email: "hal@hal.de", holdReason: "eu_domain" })], "b1", true);
    await upsertFromSheet([sheetRow({ email: null, holdReason: "no_email" })], "b1", true);
    expect(db.tables.creator_invites[0]).toMatchObject({ email: "hal@hal.de", hold_reason: "eu_domain" });
  });

  it("a bounce on a renamed row reaches the row that holds the address", async () => {
    await upsertFromSheet([sheetRow({})], "b1", true);
    await upsertFromSheet([sheetRow({ sourceKey: "ada renamed|x", sheetRow: 9, holdReason: "prior_bounce" })], "b1", true);
    const holder = db.tables.creator_invites.find((r) => r.source_key === "ada|collabstr.com/ada");
    expect(holder).toMatchObject({ email: "ada@ada.example", hold_reason: "prior_bounce" });
  });

  it("a conversation flag reaching the holder never clears the holder's own hold", async () => {
    await upsertFromSheet([sheetRow({ holdReason: "agency" })], "b1", true);
    await upsertFromSheet([sheetRow({ sourceKey: "other|x", sheetRow: 9, inConversation: true })], "b1", true);
    expect(db.tables.creator_invites[0]).toMatchObject({ hold_reason: "agency", in_conversation: true });
  });
});

describe("send-script helpers", () => {
  it("--rows: absent is empty; a typo or a header row stops the run", () => {
    expect(parseRowList(undefined, "--rows")).toEqual([]);
    expect(parseRowList("12, 40,12", "--rows")).toEqual([12, 40]);
    expect(parseRowList("12-15", "--rows")).toEqual([12, 13, 14, 15]);
    expect(parseRowList("12-14, 40, 13", "--rows")).toEqual([12, 13, 14, 40]);
    for (const bad of ["", "typo", "1", "12,,40", "12,x", "15-12", "1-5", "12-", "-5", "12-x", "2-9999999"]) expect(() => parseRowList(bad, "--rows")).toThrow(/--rows/);
  });

  it("preflight blocks a real run without key, geo ack, or a renderable email", () => {
    const ok = { apply: true, acknowledgedNoGeo: true, sendgridKey: "SG.x", renderSample: () => {} };
    expect(sendPreflight(ok)).toEqual([]);
    expect(sendPreflight({ ...ok, sendgridKey: "" })).toEqual([expect.stringMatching(/SYSTEM_SENDGRID_API_KEY/)]);
    expect(sendPreflight({ ...ok, acknowledgedNoGeo: false })).toEqual([expect.stringMatching(/acknowledge-no-geo/)]);
    expect(sendPreflight({ ...ok, acknowledgedNoGeo: false, apply: false })).toEqual([]);
    expect(
      sendPreflight({
        ...ok,
        renderSample: () => {
          throw new Error("bad");
        },
      }),
    ).toEqual([expect.stringMatching(/does not render/)]);
  });

  it("only a definite SendGrid rejection is retryable; anything else keeps the stamp", () => {
    const sg = (code: number) => Object.assign(new Error("x"), { code, response: { body: {} } });
    expect(classifySendError(sg(400))).toEqual({ kind: "rejected", stop: false });
    expect(classifySendError(sg(401))).toEqual({ kind: "rejected", stop: true });
    expect(classifySendError(sg(429))).toEqual({ kind: "rejected", stop: true });
    expect(classifySendError(sg(503))).toEqual({ kind: "ambiguous", stop: true });
    expect(classifySendError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toEqual({ kind: "ambiguous", stop: true });
    expect(classifySendError(new Error("SYSTEM_SENDGRID_API_KEY env var is missing"))).toEqual({ kind: "rejected", stop: true });
  });
});

describe("second review round", () => {

  it("re-importing a deleted creator's row (scrubbed key) never recreates their details", async () => {
    db.tables.creator_invites = [
      { ...invite({ id: "stub", source_key: "deleted:stub", display_name: "(deleted)", member_deleted_at: "t", claimed_at: "t" }) },
    ];
    const out = await upsertFromSheet([sheetRow({})], "b1", true);
    expect(out.skippedDeleted).toEqual([2]);
    expect(db.tables.creator_invites).toHaveLength(1);
    expect(db.tables.creator_invites[0].display_name).toBe("(deleted)");
  });
});

describe("third review round", () => {
  it("an import write never restores a creator deleted between the read and the write", async () => {
    await upsertFromSheet([sheetRow({})], "b1", true);
    const row = db.tables.creator_invites[0];
    db.afterRead = () => Object.assign(row, { member_deleted_at: "t", display_name: "(deleted)", profiles: {} });
    await upsertFromSheet([sheetRow({ displayName: "Ada Again", profiles: { x: { url: "https://x.com/ada", handle: "ada" } } })], "b1", true);
    expect(row).toMatchObject({ display_name: "(deleted)", profiles: {} });
  });
});

describe("upload 10 first, check them, collect missing data", () => {
  const { rows } = parseCreatorSheet(SHEET);

  it("--limit picks the first N the send would invite: email, no hold, not in conversation, no account", () => {
    const picked = pickFirstInvitable(rows, new Map(), 10).map((r) => r.displayName);
    expect(picked).toEqual(["Ada Fresh", "Kim Inbox", "Mo Collision", "Nia Multiline", "Oz Source"]);
    expect(pickFirstInvitable(rows, new Map([["kim@kim.example", "creator"]]), 2).map((r) => r.displayName)).toEqual(["Ada Fresh", "Mo Collision"]);
  });

  it("the missing-data file lists every row with no usable email, never an address", () => {
    const csv = missingEmailCsv(rows);
    expect(csv.split("\n")[0]).toBe("sheet_row,creator,hold_reason");
    expect(csv).toContain("10,Ivy NoEmail,no_email");
    expect(csv).toContain("14,Lee Inbox,duplicate_review");
    expect(csv).not.toContain("@");
  });

  it("--list hides the email unless --show-emails", () => {
    const rec = {
      display_name: "Ada",
      email: "ada@ada.example",
      label: "seeded",
      hold_reason: null,
      in_conversation: false,
      profiles: { instagram: { url: "https://www.instagram.com/ada.makes/", handle: "ada.makes" } },
      followers: { instagram: { raw: "12K", n: 12000 } },
      source_meta: { sheet_row: 2 },
    };
    expect(formatListedInvite(rec, false)).toBe("row 2 · Ada · email ✓ · seeded · instagram:ada.makes · instagram=12000");
    expect(formatListedInvite(rec, true)).toContain("ada@ada.example");
  });
});

describe("invite links never point at this laptop", () => {
  it("reads only PRAXIS_PUBLIC_BASE / BACKEND_PUBLIC_URL, with no fallback in code", () => {
    expect(inviteLinkBases({ WEB_BASE_URL: "http://localhost:3000", PUBLIC_API_URL: "http://localhost:3001" })).toEqual({
      web: null,
      api: null,
    });
    expect(inviteLinkBases({ PRAXIS_PUBLIC_BASE: " https://www.zaviagent.com/ ", BACKEND_PUBLIC_URL: "https://api.zaviagent.com" })).toEqual({
      web: "https://www.zaviagent.com",
      api: "https://api.zaviagent.com",
    });
  });

  it("a missing link URL blocks the send and names the env var", () => {
    const ok = { apply: true, acknowledgedNoGeo: true, sendgridKey: "SG.x", renderSample: () => {} };
    expect(sendPreflight({ ...ok, linkBases: inviteLinkBases({}) })).toEqual([
      expect.stringMatching(/PRAXIS_PUBLIC_BASE is not set/),
      expect.stringMatching(/BACKEND_PUBLIC_URL is not set/),
    ]);
  });

  it("only a public https base passes; the preflight blocks anything else", () => {
    expect(isPublicHttpsBase("https://www.zaviagent.com")).toBe(true);
    for (const bad of ["http://www.zaviagent.com", "https://localhost:3000", "http://127.0.0.1", "https://app.localhost", "not a url"]) {
      expect(isPublicHttpsBase(bad)).toBe(false);
    }
    const ok = { apply: true, acknowledgedNoGeo: true, sendgridKey: "SG.x", renderSample: () => {} };
    expect(sendPreflight({ ...ok, linkBases: { web: "https://www.zaviagent.com", api: "https://api.zaviagent.com" } })).toEqual([]);
    expect(sendPreflight({ ...ok, linkBases: { web: "http://localhost:3000", api: "https://api.zaviagent.com" } })).toEqual([
      expect.stringMatching(/PRAXIS_PUBLIC_BASE "http:\/\/localhost:3000" is not a public https URL/),
    ]);
    expect(sendPreflight({ ...ok, linkBases: inviteLinkBases({ PRAXIS_PUBLIC_BASE: "https://www.zaviagent.com", BACKEND_PUBLIC_URL: "http://localhost" }) })).toEqual([
      expect.stringMatching(/BACKEND_PUBLIC_URL "http:\/\/localhost" is not a public https URL/),
    ]);
  });
});

describe("public test inboxes", () => {
  it("many creators on yopmail.com are not held as an agency", () => {
    const rows = [2, 3, 4].map((n) => ({ Creator: `T${n}`, Email: `t${n}@yopmail.com`, ...clean, "Source URL": `https://collabstr.com/t${n}` }));
    const out = parseCreatorSheet(mini(rows));
    expect(out.report.sharedDomains).toEqual([]);
    expect(out.rows.map((r) => r.holdReason)).toEqual([null, null, null]);
  });
});
