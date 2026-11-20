import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rootMaybeSingle: vi.fn(),
  sessionRuns: vi.fn(),
  agentRuns: [] as unknown[],
  summaryKey: true as boolean | "throw",
  fallbackKey: true as boolean | "throw",
  settingReads: [] as Array<[string, unknown]>,
  readLiveEditState: vi.fn(),
}));

vi.mock("@/services/build/live-edit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/build/live-edit")>();
  return { ...real, readLiveEditState: mocks.readLiveEditState };
});

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string, tenantId?: string) => {
      mocks.settingReads.push([key, tenantId]);
      if (key === "build_edit_change_summary") {
        if (mocks.summaryKey === "throw") throw new Error("settings read failed");
        return mocks.summaryKey;
      }
      if (key === "build_edit_change_summary_fallback") {
        if (mocks.fallbackKey === "throw") throw new Error("settings read failed");
        return mocks.fallbackKey;
      }
      return real.getBoolSetting(key as never, tenantId as never);
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

let step = 0;

function chain(terminal: () => unknown) {
  const api: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "gte", "is", "order"]) api[m] = () => api;
  api.limit = () => terminal();
  api.maybeSingle = () => terminal();
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        step += 1;
        return step === 1 ? chain(() => mocks.rootMaybeSingle()) : chain(() => mocks.sessionRuns());
      }
      if (table === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: mocks.agentRuns, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
  }),
  serviceClient: () => ({}),
}));

import { directEditChangeSummary, getAutopilotRefines, refineChangeSummary } from "../autopilot";

const ROOT = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d01";
const EDIT = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d11";
const ENGINEER_RUN = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4e11";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function sessionWithEdit(status = "done", extraPayload: Record<string, unknown> = {}) {
  return [
    {
      id: ROOT,
      objective: "Build product: Yoga studio booking",
      status: "done",
      goal_graph: [{ status: "done", child_run_id: null, payload: { stage: "build", refine_mode: false } }],
      spend_usd: 1,
      max_usd: 5,
      created_at: "2026-09-29T10:00:00Z",
      updated_at: "2026-09-29T10:00:00Z",
      kind: "build_app",
    },
    {
      id: EDIT,
      objective: "[refine] Orders should start as pending",
      status,
      goal_graph: [
        {
          status,
          child_run_id: ENGINEER_RUN,
          payload: {
            stage: "build",
            refine_mode: true,
            idea: "Orders should start as pending",
            user_request: "Orders should start as pending",
            parent_conductor_run_id: ROOT,
            ...extraPayload,
          },
        },
      ],
      spend_usd: 1,
      max_usd: 5,
      created_at: "2026-09-29T11:00:00Z",
      updated_at: "2026-09-29T11:04:00Z",
      kind: "build_app",
    },
  ];
}

function engineerRun(over: { output_text?: string | null; parsed?: unknown; outcome?: unknown; status?: string } = {}) {
  return {
    id: ENGINEER_RUN,
    status: over.status ?? "success",
    finished_at: "2026-09-29T11:04:00Z",
    output_text:
      over.output_text === undefined
        ? "I made the change and pushed it to your app."
        : over.output_text,
    parsed:
      over.parsed === undefined
        ? {
            title: "feat: Add pending/confirmed/cancelled order status; new orders start pending",
            head_branch: "product-builder/order-status",
            merged: true,
          }
        : over.parsed,
    outcome: over.outcome === undefined ? { deliverable: "I made the change and pushed it to your app." } : over.outcome,
  };
}

type EditRow = {
  id: string;
  summary: string | null;
  status: string;
  draft: boolean;
  discarded: boolean;
  awaiting_review: boolean;
};

async function readEdit(): Promise<EditRow> {
  const res = mockRes();
  await getAutopilotRefines({ query: { session_id: ROOT } } as never, res as never);
  expect(res.statusCode).toBe(200);
  const refines = (res.body as { refines: EditRow[] }).refines;
  const edit = refines.find((r) => r.id === EDIT);
  expect(edit).toBeDefined();
  return edit!;
}

beforeEach(() => {
  step = 0;
  mocks.summaryKey = true;
  mocks.fallbackKey = true;
  mocks.settingReads = [];
  mocks.requireAuth.mockReset();
  mocks.rootMaybeSingle.mockReset();
  mocks.sessionRuns.mockReset();
  mocks.readLiveEditState.mockReset().mockResolvedValue({
    enabled: true,
    draft: { exists: true, changes: [{ sha: "draftsha1" }] },
  });
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "user-1", access_token: "tok" });
  mocks.rootMaybeSingle.mockResolvedValue({ data: { id: ROOT, created_at: "2026-09-29T10:00:00Z" }, error: null });
  mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit(), error: null });
  mocks.agentRuns = [engineerRun()];
});

describe("DEL-1323 B28: a live edit reply says what changed", () => {
  it("the ticket's yoga edit: prose output and a commit title, the reply carries the change in plain words", async () => {
    const edit = await readEdit();
    expect(edit.summary).toBe("Add pending/confirmed/cancelled order status; new orders start pending");
    expect(mocks.settingReads).toContainEqual(["build_edit_change_summary", "tnt-yoga"]);
  });

  it("the engineer's customer summary wins over the commit title", async () => {
    mocks.agentRuns = [
      engineerRun({
        parsed: {
          title: "feat: order status",
          customer_summary: "New orders now start as pending, and you can mark them confirmed or cancelled.",
        },
      }),
    ];
    expect((await readEdit()).summary).toBe(
      "New orders now start as pending, and you can mark them confirmed or cancelled.",
    );
  });

  it("the run outcome's customer summary is used when the envelope has none", async () => {
    mocks.agentRuns = [
      engineerRun({
        parsed: { title: "feat: order status" },
        outcome: { deliverable: "done", customer_summary: "Orders start as pending now." },
      }),
    ];
    expect((await readEdit()).summary).toBe("Orders start as pending now.");
  });

  it("never shows a line that names code files or Zavi's build repo", async () => {
    mocks.fallbackKey = false;
    mocks.agentRuns = [
      engineerRun({
        parsed: {
          customer_summary: "Updated app/orders/page.tsx in Praxis-build/yoga-studio",
          title: "fix: patch lib/db/orders.ts status default",
        },
        outcome: { customer_summary: "Pushed to the sandbox and merged the envelope" },
      }),
    ];
    expect((await readEdit()).summary).toBeNull();
  });

  it("a handed-back incomplete change never claims its title as what changed", async () => {
    mocks.fallbackKey = false;
    mocks.agentRuns = [engineerRun({ parsed: { title: "[incomplete] Add order status" } })];
    expect((await readEdit()).summary).toBeNull();
  });

  it("a failed edit gets no change summary", async () => {
    mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit("failed"), error: null });
    mocks.agentRuns = [engineerRun({ status: "failed" })];
    const edit = await readEdit();
    expect(edit.status).toBe("failed");
    expect(edit.summary).toBeNull();
  });

  it("a legacy pr_proposal summary still wins", async () => {
    mocks.agentRuns = [
      engineerRun({
        output_text: `<pr_proposal>${JSON.stringify({ summary: "Made the header sticky", title: "feat: header" })}</pr_proposal>`,
      }),
    ];
    expect((await readEdit()).summary).toBe("Made the header sticky");
  });

  it("an envelope in the output text with only a title still yields a line", async () => {
    mocks.agentRuns = [
      engineerRun({
        output_text: `<pr_proposal>${JSON.stringify({ title: "style(home): Make the hero button green" })}</pr_proposal>`,
        parsed: null,
      }),
    ];
    expect((await readEdit()).summary).toBe("Make the hero button green");
  });

  it("a live edit still in the draft preview carries the change summary", async () => {
    mocks.sessionRuns.mockResolvedValue({
      data: sessionWithEdit("done", { live_edit_branch: "zavi/draft" }),
      error: null,
    });
    mocks.agentRuns = [
      engineerRun({
        parsed: {
          title: "feat: Add pending/confirmed/cancelled order status; new orders start pending",
          live_edit_draft_sha: "draftsha1",
        },
      }),
    ];
    const edit = await readEdit();
    expect(edit.draft).toBe(true);
    expect(edit.summary).toBe("Add pending/confirmed/cancelled order status; new orders start pending");
  });

  it("a live edit draft the user threw away carries no change summary", async () => {
    mocks.readLiveEditState.mockResolvedValue({ enabled: true, draft: { exists: false, changes: [] } });
    mocks.sessionRuns.mockResolvedValue({
      data: sessionWithEdit("done", { live_edit_branch: "zavi/draft" }),
      error: null,
    });
    mocks.agentRuns = [
      engineerRun({
        parsed: { customer_summary: "New orders now start as pending.", live_edit_draft_sha: "draftsha1" },
      }),
    ];
    const edit = await readEdit();
    expect(edit.discarded).toBe(true);
    expect(edit.summary).toBeNull();
  });

  it("a change saved for review (not live yet) carries the change summary", async () => {
    mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit("done", { defer_pr: true }), error: null });
    mocks.agentRuns = [
      engineerRun({
        parsed: { customer_summary: "New orders now start as pending.", merged: false },
      }),
    ];
    const edit = await readEdit();
    expect(edit.awaiting_review).toBe(true);
    expect(edit.summary).toBe("New orders now start as pending.");
  });

  it("key off: a draft live edit still gets no summary", async () => {
    mocks.summaryKey = false;
    mocks.sessionRuns.mockResolvedValue({
      data: sessionWithEdit("done", { live_edit_branch: "zavi/draft" }),
      error: null,
    });
    mocks.agentRuns = [engineerRun({ parsed: { title: "feat: order status", live_edit_draft_sha: "draftsha1" } })];
    const edit = await readEdit();
    expect(edit.draft).toBe(true);
    expect(edit.summary).toBeNull();
  });

  it("key off: the reply stays the bare 'Live on your app' (summary null), exactly as before", async () => {
    mocks.summaryKey = false;
    expect((await readEdit()).summary).toBeNull();
  });

  it("a failed settings read keeps the old behaviour", async () => {
    mocks.summaryKey = "throw";
    expect((await readEdit()).summary).toBeNull();
  });
});

describe("DEL-1323 B28: a live edit reply is never the bare 'Live on your app'", () => {
  const JARGON_PARSED = {
    customer_summary: "Updated src/components/Header.tsx in Praxis-build/yoga-studio",
    title: "fix: hydration mismatch in Header component",
  };
  const envelope = (files: Array<{ path: string; action: string }>, extra: Record<string, unknown> = {}) =>
    `I made the change.\n<pr_proposal>${JSON.stringify({ title: "refactor: Header component", files, ...extra })}</pr_proposal>`;

  it("jargon summary and jargon title: the reply names the changed parts from the commit's files, never a path", async () => {
    mocks.agentRuns = [
      engineerRun({
        output_text: envelope([
          { path: "src/app/(marketing)/pricing/page.tsx", action: "modify" },
          { path: "src/components/SiteHeader.tsx", action: "modify" },
          { path: "src/app/globals.css", action: "modify" },
        ]),
        parsed: JARGON_PARSED,
        outcome: { customer_summary: "Pushed to the sandbox and merged the envelope" },
      }),
    ];
    const edit = await readEdit();
    expect(edit.summary).toBe("Updated your pricing page, your header and your site's look");
    expect(edit.summary).not.toMatch(/\.tsx|\.css|src\/|Praxis-build|sandbox|component/i);
    expect(mocks.settingReads).toContainEqual(["build_edit_change_summary_fallback", "tnt-yoga"]);
  });

  it("files carried on the parsed envelope are used when the output text has none", async () => {
    mocks.agentRuns = [
      engineerRun({
        output_text: "I made the change.",
        parsed: { ...JARGON_PARSED, files: [{ path: "src/pages/Home.tsx", action: "modify" }, null, { path: 7 }] },
        outcome: {},
      }),
    ];
    expect((await readEdit()).summary).toBe("Updated your home page");
  });

  it("nothing at all known about the change: a neutral plain line, not null", async () => {
    mocks.agentRuns = [engineerRun({ output_text: "done", parsed: JARGON_PARSED, outcome: null })];
    expect((await readEdit()).summary).toBe("Updated your site");
  });

  it("an incomplete title with no files still gets a plain line on a done edit", async () => {
    mocks.agentRuns = [engineerRun({ parsed: { title: "[incomplete] Add order status" } })];
    expect((await readEdit()).summary).toBe("Updated your site");
  });

  it("the engineer's own plain summary still wins over the fallback", async () => {
    mocks.agentRuns = [
      engineerRun({
        output_text: envelope([{ path: "src/app/globals.css", action: "modify" }]).replace('"title":"refactor: Header component"', '"title":"Make the buttons green"'),
        parsed: { customer_summary: "Your buttons are green now." },
      }),
    ];
    expect((await readEdit()).summary).toBe("Your buttons are green now.");
  });

  it("a failed, discarded or summary-off edit never gets the fallback", async () => {
    mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit("failed"), error: null });
    mocks.agentRuns = [engineerRun({ status: "failed", parsed: JARGON_PARSED })];
    expect((await readEdit()).summary).toBeNull();

    step = 0;
    mocks.readLiveEditState.mockResolvedValue({ enabled: true, draft: { exists: false, changes: [] } });
    mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit("done", { live_edit_branch: "zavi/draft" }), error: null });
    mocks.agentRuns = [engineerRun({ parsed: { ...JARGON_PARSED, live_edit_draft_sha: "draftsha1" } })];
    const discarded = await readEdit();
    expect(discarded.discarded).toBe(true);
    expect(discarded.summary).toBeNull();

    step = 0;
    mocks.summaryKey = false;
    mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit(), error: null });
    mocks.agentRuns = [engineerRun({ parsed: JARGON_PARSED })];
    mocks.settingReads = [];
    expect((await readEdit()).summary).toBeNull();
    expect(mocks.settingReads.map(([k]) => k)).not.toContain("build_edit_change_summary_fallback");
  });

  it("fallback key off or unreadable: the old null summary", async () => {
    mocks.agentRuns = [engineerRun({ parsed: JARGON_PARSED })];
    mocks.fallbackKey = false;
    expect((await readEdit()).summary).toBeNull();
    step = 0;
    mocks.fallbackKey = "throw";
    expect((await readEdit()).summary).toBeNull();
  });

  it("the fallback switch is a per-tenant setting that ships on", async () => {
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    expect((APP_SETTINGS as Record<string, unknown>).build_edit_change_summary_fallback).toMatchObject({
      type: "boolean",
      scope: "per-tenant",
      defaultValue: true,
    });
  });
});

describe("a direct text edit says which words changed", () => {
  const DIRECT = 'Changed "Baked fresh daily for your neighbourhoods." to "Baked fresh daily for your sdfds neighbourhoods."';

  it("the reply carries the before and after text, not the neutral line", async () => {
    mocks.sessionRuns.mockResolvedValue({
      data: sessionWithEdit("done", { direct_text_edit: true, direct_commit_sha: "c".repeat(40), customer_summary: DIRECT, user_request: "Applied 1 edit" }),
      error: null,
    });
    mocks.agentRuns = [];
    const edit = await readEdit();
    expect(edit.summary).toBe(DIRECT);
  });

  it("an old direct edit recorded without its words still gets the neutral line", async () => {
    mocks.sessionRuns.mockResolvedValue({
      data: sessionWithEdit("done", { direct_text_edit: true, direct_commit_sha: "c".repeat(40), user_request: "Applied 1 edit" }),
      error: null,
    });
    mocks.agentRuns = [];
    const edit = await readEdit();
    expect(edit.summary).toBe("Updated your site");
  });

  it("only a direct edit's own summary is read off the node, never an engineer edit's payload", () => {
    expect(directEditChangeSummary({ direct_text_edit: true, customer_summary: DIRECT })).toBe(DIRECT);
    expect(directEditChangeSummary({ customer_summary: DIRECT })).toBeNull();
    expect(directEditChangeSummary({ direct_text_edit: true, customer_summary: "Changed src/App.tsx" })).toBeNull();
    expect(directEditChangeSummary(null)).toBeNull();
  });
});

describe("refineChangeSummary", () => {
  it("returns null for nothing usable", () => {
    expect(refineChangeSummary(null, null, null)).toBeNull();
    expect(refineChangeSummary("<pr_proposal>{not json}</pr_proposal>", { title: "  " }, {})).toBeNull();
  });

  it("caps a long line at 280 characters", () => {
    const out = refineChangeSummary(null, { customer_summary: "a".repeat(600) }, null);
    expect(out).toHaveLength(280);
    expect(out!.endsWith("…")).toBe(true);
    expect(out!.slice(0, 279)).toBe("a".repeat(279));
  });

  it("does not add an ellipsis to a line that fits", () => {
    const text = "b".repeat(280);
    expect(refineChangeSummary(null, { customer_summary: text }, null)).toBe(text);
  });

  it("a long title is cut with an ellipsis", () => {
    const out = refineChangeSummary(null, { title: `feat: ${"c".repeat(400)}` }, null);
    expect(out).toHaveLength(280);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("uses only the first line of a multi-line title", () => {
    expect(refineChangeSummary(null, { title: "fix: Correct the price on the menu\n\nBody text" }, null)).toBe(
      "Correct the price on the menu",
    );
  });

  it("drops a title a reviewer would write, and strips a bracket tag from a plain one", () => {
    for (const title of [
      "Fix hydration mismatch in Navbar component",
      "Refactor useCart hook",
      "[WIP] Refactor checkout",
      "chore: bump deps",
      "fix: lint and typecheck errors",
      "Add tests for the booking form",
      "Merge branch main into zavi/draft",
      "Move cart state into useCart",
      "Pass props through the header",
    ]) {
      expect(refineChangeSummary(null, { title }, null), title).toBeNull();
    }
    expect(refineChangeSummary(null, { title: "[WIP] Make the hero button green" }, null)).toBe(
      "Make the hero button green",
    );
    expect(refineChangeSummary(null, { title: "[draft] feat: show the user's saved cars" }, null)).toBe(
      "Show the user's saved cars",
    );
  });
});

describe("a change asked for in a chat thread names that thread", () => {
  const THREAD = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4f21";

  it("returns the thread the founder asked in, so the Build chat can tell its own turn from the change", async () => {
    mocks.sessionRuns.mockResolvedValue({ data: sessionWithEdit("done", { chat_thread_id: THREAD }), error: null });
    const edit = (await readEdit()) as EditRow & { chat_thread_id: string | null };
    expect(edit.chat_thread_id).toBe(THREAD);
  });

  it("returns null for a change started from the Build page itself", async () => {
    const edit = (await readEdit()) as EditRow & { chat_thread_id: string | null };
    expect(edit.chat_thread_id).toBeNull();
  });
});
