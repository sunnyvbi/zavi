import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  startRun: vi.fn(),
  heartbeat: vi.fn(),
  finishRun: vi.fn(),
  getRun: vi.fn(),
  listRecent: vi.fn(),
  reapStale: vi.fn(),
  writeStaffAudit: vi.fn(),
  countBatch: vi.fn(),
  reconcileLinks: vi.fn(),
  listBatch: vi.fn(),
  selectInviteRows: vi.fn(),
  runInviteSend: vi.fn(),
  planUpload: vi.fn(),
}));

vi.mock("@/services/admin-scripts/runs", async (orig) => {
  const real = await orig<typeof import("@/services/admin-scripts/runs")>();
  return { ...real, startRun: m.startRun, heartbeat: m.heartbeat, finishRun: m.finishRun, getRun: m.getRun, listRecent: m.listRecent, reapStale: m.reapStale };
});
vi.mock("@/services/staff/audit", () => ({ writeStaffAuditStrict: m.writeStaffAudit }));
vi.mock("@/services/creators/creator-invites", async (orig) => {
  const real = await orig<typeof import("@/services/creators/creator-invites")>();
  return { ...real, countBatch: m.countBatch, listBatch: m.listBatch, reconcileLinks: m.reconcileLinks };
});
vi.mock("@/services/creators/creator-invite-send", async (orig) => {
  const real = await orig<typeof import("@/services/creators/creator-invite-send")>();
  return { ...real, selectInviteRows: m.selectInviteRows, runInviteSend: m.runInviteSend };
});
vi.mock("@/services/creators/creator-invite-upload", async (orig) => {
  const real = await orig<typeof import("@/services/creators/creator-invite-upload")>();
  return { ...real, planUpload: m.planUpload };
});

import { AlreadyRunningError } from "@/services/admin-scripts/runs";
import { recipientsFingerprint } from "@/services/admin-scripts/registry";
import { adminScriptRunGet, adminScriptRunPost, adminScriptsList, scriptUploadMiddleware } from "../scripts";

let baseUrl = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staff: unknown }).staff = { user_id: "staff-1", email: "staff@zaviagent.com" };
    next();
  });
  app.get("/scripts", adminScriptsList);
  app.get("/scripts/runs/:id", adminScriptRunGet);
  app.post("/scripts/:key/run", scriptUploadMiddleware, adminScriptRunPost);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server?.close();
});

const post = (key: string, body: unknown) =>
  fetch(`${baseUrl}/scripts/${key}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const TOKEN = () => recipientsFingerprint(["id-2", "id-3"]);
const inviteRow = (n: number) => ({ id: `id-${n}`, display_name: `Creator ${n}`, email: `c${n}@x.com`, unsub_token: `tok-${n}`, source_meta: { sheet_row: n } });

beforeEach(() => {
  vi.resetAllMocks();
  m.reapStale.mockResolvedValue(0);
  m.listRecent.mockResolvedValue([]);
  m.countBatch.mockResolvedValue(3);
  m.startRun.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });
  m.heartbeat.mockResolvedValue(undefined);
  m.finishRun.mockResolvedValue(undefined);
  m.selectInviteRows.mockResolvedValue({ eligibleCount: 2, toSend: [inviteRow(2), inviteRow(3)], skipped: [] });
  m.runInviteSend.mockResolvedValue({ tally: { total: 2, attempted: 2, sent: 2, rejected: 0, unknown: 0, changed: 0, render_skipped: 0 }, stoppedReason: null });
});

describe("/api/admin/scripts", () => {
  it("lists the scripts without their code", async () => {
    const body = await (await fetch(`${baseUrl}/scripts`)).json();
    expect(body.scripts.map((s: { key: string }) => s.key)).toEqual(["creator-upload", "creator-list", "creator-send", "channel-exec-failures-sort", "channel-card-chain", "build-continue", "site-name-fix", "site-smoke-hooks", "platform-worker-secrets", "bulk-email-clear-hold", "bulk-email-resume-send"]);
    expect(JSON.stringify(body.scripts)).not.toMatch(/prepareApply|dryRun/);
  });

  it("404s an unknown script and 400s bad args or mode", async () => {
    expect((await post("nope", { mode: "dry_run", args: {} })).status).toBe(404);
    expect((await post("creator-send", { mode: "dry_run", args: { batch: "bad batch!" } })).status).toBe(400);
    expect((await post("creator-send", { mode: "delete", args: { batch: "b1" } })).status).toBe(400);
    expect((await post("creator-list", { mode: "apply", args: { batch: "b1" } })).status).toBe(400);
  });

  it("send apply with the wrong count is refused before any run row exists", async () => {
    const res = await post("creator-send", { mode: "apply", args: { batch: "b1" }, confirm: "SEND 5", preview_token: TOKEN() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "confirm_mismatch", expected: "SEND 2" });
    expect(m.startRun).not.toHaveBeenCalled();
    expect(m.runInviteSend).not.toHaveBeenCalled();
  });

  it("send apply starts one background run with the confirmed list and no PII in stored args", async () => {
    const res = await post("creator-send", { mode: "apply", args: { batch: "b1", max: "50" }, confirm: "SEND 2", preview_token: TOKEN() });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ async: true, run_id: "11111111-1111-1111-1111-111111111111" });
    const start = m.startRun.mock.calls[0][0];
    expect(start).toMatchObject({ scriptKey: "creator-send", lockKey: "*", runBy: "staff-1" });
    expect(JSON.stringify(start.args)).not.toMatch(/@|tok-|Creator/);
    expect(m.writeStaffAudit.mock.calls[0][0]).toMatchObject({ action: "admin_script.creator-send.apply", target_id: "11111111-1111-1111-1111-111111111111" });
    await vi.waitFor(() => expect(m.finishRun).toHaveBeenCalled());
    expect(m.selectInviteRows.mock.calls[0][0].apply).toBe(false);
    expect(m.reconcileLinks).toHaveBeenCalledTimes(1);
    expect(m.runInviteSend.mock.calls[0][0].preselected.map((r: { id: string }) => r.id)).toEqual(["id-2", "id-3"]);
    expect(m.finishRun.mock.calls[0][1]).toMatchObject({ status: "done" });
  });

  it("a second send while one is running gets 409 already_running", async () => {
    m.startRun.mockRejectedValue(new AlreadyRunningError("22222222-2222-2222-2222-222222222222"));
    const res = await post("creator-send", { mode: "apply", args: { batch: "b1" }, confirm: "SEND 2", preview_token: TOKEN() });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "already_running", run_id: "22222222-2222-2222-2222-222222222222" });
  });

  it("list hides emails unless asked, and an unmasked list is audit-logged without the emails", async () => {
    m.listBatch.mockResolvedValue([
      { display_name: "A", email: "a@x.com", label: "seeded", hold_reason: null, in_conversation: false, profiles: null, followers: null, source_meta: { sheet_row: 2 } },
    ]);
    const masked = await (await post("creator-list", { mode: "dry_run", args: { batch: "b1" } })).json();
    expect(masked.result.rows[0]).toMatchObject({ email: null, has_email: true });
    expect(m.writeStaffAudit).not.toHaveBeenCalled();
    const shown = await (await post("creator-list", { mode: "dry_run", args: { batch: "b1", show_emails: true } })).json();
    expect(shown.result.rows[0].email).toBe("a@x.com");
    expect(m.writeStaffAudit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(m.writeStaffAudit.mock.calls[0][0])).not.toMatch(/a@x\.com/);
  });

  it("upload refuses a file over 2 MB with 413 and a non-csv with 400", async () => {
    const big = new FormData();
    big.set("mode", "dry_run");
    big.set("batch", "b1");
    big.set("file", new Blob(["x".repeat(2 * 1024 * 1024 + 10)]), "creators.csv");
    expect((await fetch(`${baseUrl}/scripts/creator-upload/run`, { method: "POST", body: big })).status).toBe(413);

    const txt = new FormData();
    txt.set("mode", "dry_run");
    txt.set("batch", "b1");
    txt.set("file", new Blob(["a,b"]), "creators.txt");
    expect((await fetch(`${baseUrl}/scripts/creator-upload/run`, { method: "POST", body: txt })).status).toBe(400);
    expect(m.planUpload).not.toHaveBeenCalled();
  });

  it("upload apply needs APPLY and never stores the file contents", async () => {
    m.planUpload.mockResolvedValue({
      report: { rowsRead: 1, blankRows: 0, errors: [], sheetDuplicates: [], sameEmailDuplicates: [], duplicateReview: [], sourceKeyDuplicates: [], sharedDomains: [] },
      rowCount: 1, withEmail: 1, holds: {}, inConversation: 0, hasAccountRows: [], invitableNow: 1, invitableWithConversation: 1,
      limit: null, loaded: [], result: { inserted: 1, updated: 0, emailConflicts: [], skippedDeleted: [] }, missingEmailCsv: "sheet_row,creator,hold_reason\n",
    });
    const form = () => {
      const f = new FormData();
      f.set("mode", "apply");
      f.set("batch", "b1");
      f.set("file", new Blob(["Creator,Email\nA,secret@x.com\n"]), "creators.csv");
      return f;
    };
    const noConfirm = await fetch(`${baseUrl}/scripts/creator-upload/run`, { method: "POST", body: form() });
    expect(noConfirm.status).toBe(409);
    const f = form();
    f.set("confirm", "APPLY");
    const ok = await fetch(`${baseUrl}/scripts/creator-upload/run`, { method: "POST", body: f });
    expect(ok.status).toBe(200);
    expect(m.planUpload.mock.calls[0][0]).toMatchObject({ apply: true, batch: "b1" });
    const stored = JSON.stringify(m.startRun.mock.calls[0][0].args);
    expect(stored).not.toContain("creators.csv");
    expect(stored).not.toMatch(/secret@x\.com/);
    expect(m.finishRun.mock.calls[0][1]).toMatchObject({ status: "done", summary: { inserted: 1 } });
  });

  it("send apply refuses a same-sized but different list than the dry run previewed", async () => {
    const stale = recipientsFingerprint(["id-2", "id-4"]);
    const res = await post("creator-send", { mode: "apply", args: { batch: "b1" }, confirm: "SEND 2", preview_token: stale });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("list_changed");
    const noToken = await post("creator-send", { mode: "apply", args: { batch: "b1" }, confirm: "SEND 2" });
    expect((await noToken.json()).error.code).toBe("list_changed");
    expect(m.startRun).not.toHaveBeenCalled();
  });

  it("the dry run returns the fingerprint of exactly the previewed recipients", async () => {
    m.runInviteSend.mockResolvedValue({ eligibleCount: 2, toSend: [inviteRow(2), inviteRow(3)], skipped: [], problems: [], sender: { name: "Z", email: "s@z.com" }, links: { web: "https://w", api: "https://a" }, tally: {} });
    const body = await (await post("creator-send", { mode: "dry_run", args: { batch: "b1" } })).json();
    expect(body.result.preview_token).toBe(TOKEN());
    expect(JSON.stringify(body.result)).not.toMatch(/tok-2|c2@x\.com/);
  });

  it("when the audit row cannot be written, the send does not run", async () => {
    m.writeStaffAudit.mockRejectedValue(new Error("audit down"));
    const res = await post("creator-send", { mode: "apply", args: { batch: "b1" }, confirm: "SEND 2", preview_token: TOKEN() });
    expect(res.status).toBe(500);
    expect(m.runInviteSend).not.toHaveBeenCalled();
    expect(m.reconcileLinks).not.toHaveBeenCalled();
    expect(m.finishRun.mock.calls[0][1]).toMatchObject({ status: "failed" });
  });

  it("an unmasked list is not returned when its audit row cannot be written", async () => {
    m.listBatch.mockResolvedValue([{ display_name: "A", email: "a@x.com", label: "seeded", hold_reason: null, in_conversation: false, profiles: null, followers: null, source_meta: { sheet_row: 2 } }]);
    m.writeStaffAudit.mockRejectedValue(new Error("audit down"));
    const res = await post("creator-list", { mode: "dry_run", args: { batch: "b1", show_emails: true } });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("a@x.com");
  });
});
