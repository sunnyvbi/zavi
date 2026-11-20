import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
const db = {
  view: null as Record<string, unknown> | null,
  viewFails: false,
  campaigns: [] as Array<Record<string, unknown>>,
  campaignsFail: false,
  checkedFor: null as string | null,
  today: "2026-10-20",
  rpc: [] as string[],
  bindings: [] as Array<Record<string, unknown>>,
};

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
    db.rpc.push(name);
    if (name === "ad_budget_month_view") {
      if (db.viewFails) return { data: null, error: { message: "db down" } };
      return { data: db.view, error: null };
    }
    if (tid !== T) throw new Error("wrong tenant");
    if (name === "claim_ad_budget_brake") {
      if (args.p_budget_id !== "b1" || db.checkedFor === db.today) return { data: { claimed: false, day: db.today }, error: null };
      db.checkedFor = db.today;
      return { data: { claimed: true, day: db.today }, error: null };
    }
    if (name === "release_ad_budget_brake") {
      db.checkedFor = null;
      return { data: { status: "released" }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  },
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      if (table === "ads_campaign_binding_details") {
        const filters: Array<[string, unknown]> = [];
        const b = {
          select: () => b,
          eq: (col: string, val: unknown) => (filters.push([col, val]), b),
          range: async () => ({ data: (tid === T ? db.bindings : []).filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }),
        };
        return b;
      }
      if (table !== "ad_campaigns") throw new Error(`unexpected table ${table}`);
      let rows = () => (tid === T ? db.campaigns : []);
      const q = {
        select: () => q,
        in: (col: string, vals: unknown[]) => {
          const prev = rows;
          rows = () => prev().filter((r) => vals.includes(r[col]));
          return q;
        },
        gte: (col: string, val: string) => {
          const prev = rows;
          rows = () => prev().filter((r) => typeof r[col] === "string" && (r[col] as string) >= val);
          return q;
        },
        neq: (col: string, val: unknown) => {
          const prev = rows;
          rows = () => prev().filter((r) => r[col] != null && r[col] !== val);
          return q;
        },
        or: (expr: string) => {
          const terms = expr.split(",").map((t) => t.split("."));
          const prev = rows;
          rows = () => prev().filter((r) => terms.some(([col, op, val]) =>
            op === "is" && val === "null" ? r[col] == null : op === "neq" ? r[col] != null && r[col] !== val : false));
          return q;
        },
        limit: async (n: number) =>
          db.campaignsFail
            ? { data: null, error: { message: "db down" } }
            : { data: rows().slice(0, Math.min(n, 1000)), error: null },
      };
      return q;
    },
  }),
}));

const autopilot = { value: false as boolean | "throw" };
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (key: string) => {
    if (key !== "cgo_autopilot_enabled") throw new Error(`unexpected setting ${key}`);
    if (autopilot.value === "throw") throw new Error("settings down");
    return autopilot.value;
  },
}));

const inngestSend = vi.fn(async (_e: unknown) => undefined);
vi.mock("@/../workers/client", () => ({ inngest: { send: (e: unknown) => inngestSend(e) } }));

import { LIVE_ACCOUNT_MS, projectMonth, readLiveMonthProjection, runBudgetBrake, suggestCuts, renderBrakeWarning, type CampaignRow } from "../ad-budget-brake";

function view(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    status: "active",
    monthly_usd: 25000,
    month_cap_usd: 25000,
    spent_usd: 15000,
    held_usd: 0,
    left_usd: 10000,
    daily_limit_usd: null,
    next_month_start: "2026-11-01",
    days_left: 12,
    days_in_month: 31,
    started_on: "2026-09-01",
    created_at: "2026-09-01T00:00:00Z",
    stopped_at: null,
    month_start: "2026-10-01",
    ...over,
  };
}
const row = (o: Partial<CampaignRow> & { object_id: string; account_id?: string }): CampaignRow & { account_id: string } => ({
  account_id: o.platform === "google" ? "9" : "act_1",
  platform: "meta",
  name: null,
  budget_kind: "daily",
  budget_usd: 100,
  status: "ACTIVE",
  ...o,
});

const OVER_ROWS: CampaignRow[] = [
  row({ object_id: "as-big", name: "Prospecting <US>", budget_usd: 600 }),
  row({ object_id: "as-small", name: "Retargeting", budget_usd: "150.00" }),
  row({ platform: "google", object_id: "111", name: "Brand search", budget_usd: 250, status: "ENABLED" }),
  row({ object_id: "as-life", name: "Launch week", budget_kind: "lifetime", budget_usd: 5000 }),
  row({ object_id: "as-cbo", name: "CBO set", budget_kind: "campaign_level", budget_usd: null }),
  row({ platform: "google", object_id: "222", name: "Shared pool", budget_kind: "shared", budget_usd: null, status: "ENABLED" }),
  row({ object_id: "as-paused", budget_usd: 900, status: "PAUSED" }),
  row({ platform: "google", object_id: "333", budget_usd: 900, status: "PAUSED" }),
  row({ object_id: "as-gone", budget_usd: 900, status: "removed" }),
];

const send = vi.fn(async (_t: string, _n: { subject: string; html: string; text: string }) => "sent");
const BUDGET_URL = `http://localhost:3000/workspace?tab=growth-strategy&company=${T}#ad-budget`;
const CTX = { companyName: "Acme Rentals", autopilot: "off" as const, url: BUDGET_URL };

beforeEach(() => {
  db.view = view();
  db.viewFails = false;
  db.campaigns = OVER_ROWS as unknown as Array<Record<string, unknown>>;
  db.campaignsFail = false;
  db.checkedFor = null;
  db.today = "2026-10-20";
  db.rpc = [];
  db.bindings = [];
  autopilot.value = false;
  inngestSend.mockReset();
  inngestSend.mockImplementation(async () => undefined);
  send.mockReset();
  send.mockImplementation(async () => "sent");
});

describe("projectMonth", () => {
  it("spent + running DAILY budgets x days left; lifetime, campaign-level, shared and paused add nothing", () => {
    const p = projectMonth(view(), OVER_ROWS);
    expect(p.running_daily_usd).toBe(1000);
    expect(p.projected_usd).toBe(27000);
    expect(p.over).toBe(true);
    expect(p.daily.map((o) => o.object_id)).toEqual(["as-big", "as-small", "111"]);
    expect(p.cannot_lower.map((o) => o.object_id)).toEqual(["as-life", "as-cbo", "222"]);
  });

  it("exactly at the cap is on track; a cent over is not", () => {
    expect(projectMonth(view({ spent_usd: 13000 }), OVER_ROWS).over).toBe(false);
    expect(projectMonth(view({ spent_usd: 13000.01 }), OVER_ROWS).over).toBe(true);
  });

  it("a lifetime budget alone never makes the month look over", () => {
    const p = projectMonth(view({ spent_usd: 100 }), [row({ object_id: "l", budget_kind: "lifetime", budget_usd: 1e6 })]);
    expect(p.projected_usd).toBe(100);
    expect(p.over).toBe(false);
  });
});

describe("projectMonth: every ad platform's running budgets count (fix for #4042)", () => {
  const V = view({ spent_usd: 0, month_cap_usd: 1000, days_left: 20 });
  it.each(["tiktok", "pinterest", "snapchat", "microsoft", "apple", "spotify", "linkedin"])(
    "a running %s daily budget is projected for every day left",
    (platform) => {
      const p = projectMonth(V, [row({ platform, object_id: "x", budget_usd: 30 })]);
      expect(p.running_daily_usd).toBe(30);
      expect(p.projected_usd).toBe(600);
    },
  );
  it("a status the brake cannot read fails closed: it counts as running", () => {
    for (const status of [null, "BUDGETPAUSED", "SOMETHING_NEW"]) {
      const p = projectMonth(V, [row({ platform: "linkedin", object_id: "x", budget_usd: 30, status })]);
      expect(p.running_daily_usd).toBe(30);
    }
    expect(projectMonth(V, [row({ platform: "newplatform", object_id: "x", budget_usd: 30 })]).running_daily_usd).toBe(30);
  });
  it("a known stopped status on these platforms adds nothing", () => {
    for (const status of ["PAUSED", "CAMPAIGN_PAUSED", "ARCHIVED", "DELETED", "DELETE", "COMPLETED", "CANCELED", "DRAFT", "PENDING_DELETION", "BUDGETANDMANUALPAUSED", "SUSPENDED"]) {
      const p = projectMonth(V, [row({ platform: "pinterest", object_id: "x", budget_usd: 30, status })]);
      expect(p.running_daily_usd, status).toBe(0);
    }
  });
});

describe("suggestCuts", () => {
  it("one ratio for every daily budget, rounded down to the cent, and the result fits the cap", () => {
    const p = projectMonth(view(), OVER_ROWS);
    const s = suggestCuts(p);
    expect(s.fits).toBe(true);
    expect(s.cuts).toEqual([
      { platform: "meta", object_id: "as-big", name: "Prospecting <US>", current_usd: 600, suggested_usd: 499.99 },
      { platform: "meta", object_id: "as-small", name: "Retargeting", current_usd: 150, suggested_usd: 124.99 },
      { platform: "google", object_id: "111", name: "Brand search", current_usd: 250, suggested_usd: 208.33 },
    ]);
    const newDaily = s.cuts.reduce((t, c) => t + c.suggested_usd, 0);
    expect(15000 + newDaily * 12).toBeLessThanOrEqual(25000);
    expect(s.new_daily_usd).toBeCloseTo(833.31, 2);
  });

  it("never below the platform minimum; the others take the rest, and it still fits", () => {
    const p = projectMonth(view({ month_cap_usd: 1000, spent_usd: 900, days_left: 10 }), [
      row({ object_id: "tiny", budget_usd: 2 }),
      row({ object_id: "main", budget_usd: 108 }),
    ]);
    const s = suggestCuts(p);
    expect(s.cuts).toEqual([
      { platform: "meta", object_id: "tiny", name: null, current_usd: 2, suggested_usd: 1 },
      { platform: "meta", object_id: "main", name: null, current_usd: 108, suggested_usd: 9 },
    ]);
    expect(s.fits).toBe(true);
  });

  it("when even every minimum does not fit, every budget goes to its minimum and says so", () => {
    const p = projectMonth(view({ month_cap_usd: 1000, spent_usd: 999, days_left: 10 }), [
      row({ object_id: "a", budget_usd: 50 }),
      row({ platform: "google", object_id: "b", budget_usd: 0.5, status: "ENABLED" }),
    ]);
    const s = suggestCuts(p);
    expect(s.fits).toBe(false);
    expect(s.cuts).toEqual([{ platform: "meta", object_id: "a", name: null, current_usd: 50, suggested_usd: 1 }]);
    const w = renderBrakeWarning(p, s, CTX);
    expect(w.text).toContain("Even at each platform's minimum");
    expect(w.text).toContain("Pause some of them");
  });

  it("never suggests a LinkedIn daily budget under LinkedIn's $10 minimum, and suggests pausing when even $10 is over", () => {
    const fits = suggestCuts(projectMonth(view({ month_cap_usd: 1000, spent_usd: 700, days_left: 10 }), [
      row({ platform: "linkedin", object_id: "li-a", budget_usd: 40, status: "ACTIVE" }),
      row({ platform: "linkedin", object_id: "li-b", budget_usd: 40, status: "ACTIVE" }),
    ]));
    expect(fits.fits).toBe(true);
    expect(fits.cuts.map((c) => c.suggested_usd)).toEqual([15, 15]);
    const p = projectMonth(view({ month_cap_usd: 1000, spent_usd: 950, days_left: 10 }), [
      row({ platform: "linkedin", object_id: "li-a", budget_usd: 40, status: "ACTIVE" }),
      row({ platform: "linkedin", object_id: "li-b", budget_usd: 40, status: "ACTIVE" }),
    ]);
    const s = suggestCuts(p);
    expect(s.fits).toBe(false);
    expect(s.cuts).toEqual([
      { platform: "linkedin", object_id: "li-a", name: null, current_usd: 40, suggested_usd: 10 },
      { platform: "linkedin", object_id: "li-b", name: null, current_usd: 40, suggested_usd: 10 },
    ]);
    expect(s.cuts.every((c) => c.suggested_usd >= 10)).toBe(true);
    const w = renderBrakeWarning(p, s, CTX);
    expect(w.text).toContain("Pause some of them");
    expect(w.text).not.toMatch(/\$[0-9]\.[0-9]{2} a day/);
  });
});

const READ = [{ platform: "meta", account_id: "act_1" }, { platform: "google", account_id: "9" }];

describe("runBudgetBrake", () => {
  it("rows of an account this hour's read did not cover (disconnected or replaced) are left out", async () => {
    db.campaigns = [
      ...(OVER_ROWS as unknown as Array<Record<string, unknown>>),
      { ...row({ object_id: "old-acct", budget_usd: 5000 }), account_id: "act_OLD" },
    ];
    const withOld = await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send });
    expect(withOld).toEqual({ status: "warned", projected_usd: 27000, cap_usd: 25000, cuts: 3 });
    send.mockClear();
  });

  it("old accounts' rows are filtered in the query, so 1,000 of them never hide a live campaign", async () => {
    db.campaigns = [
      ...Array.from({ length: 1000 }, (_, i) => ({ ...row({ object_id: `old${i}`, budget_usd: 1 }), account_id: "act_OLD" })),
      ...(OVER_ROWS as unknown as Array<Record<string, unknown>>),
    ] as unknown as Array<Record<string, unknown>>;
    expect(await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).toEqual({
      status: "warned", projected_usd: 27000, cap_usd: 25000, cuts: 3,
    });
    send.mockClear();
  });

  it("Autopilot OFF: ONE email with the numbers, the suggested cuts, the cannot-lower list and 'Zavi changed nothing'", async () => {
    const out = await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send });
    expect(out).toEqual({ status: "warned", projected_usd: 27000, cap_usd: 25000, cuts: 3 });
    expect(send).toHaveBeenCalledTimes(1);
    const [tenant, note] = send.mock.calls[0];
    expect(tenant).toBe(T);
    expect(note.text).toContain("On track for $27,000.00 of $25,000.00 this month.");
    expect(note.text).toContain('- Meta ad set "Prospecting <US>": $600.00 a day to $499.99 a day');
    expect(note.text).toContain('- Google Ads campaign "Brand search": $250.00 a day to $208.33 a day');
    expect(note.text).toContain('- Meta ad set "Launch week" (lifetime budget)');
    expect(note.text).toContain('- Meta ad set "CBO set" (budget set on the campaign)');
    expect(note.text).toContain('- Google Ads campaign "Shared pool" (shared budget)');
    expect(note.text).toContain("Zavi changed nothing.");
    expect(note.text).not.toContain("—");
    expect(note.html).toContain("Prospecting &lt;US&gt;");
    expect(note.html).not.toContain("<US>");
    const visible = note.html.replace(/<div style="display:none[^>]*>[^<]*<\/div>/, "");
    expect(visible.split("Zavi changed nothing.").length - 1).toBe(1);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("the warning names the company, the numbers, and links to the real budget page", async () => {
    await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send, companyName: async () => "Acme Rentals" });
    const [, note] = send.mock.calls[0];
    expect(note.subject).toBe("Acme Rentals: ads on track for $27,000 of your $25,000 budget");
    expect(note.text.split("\n")[0]).toBe(
      "At today's daily budgets you'll spend about $2,000 more than this month's $25,000 budget. Zavi changed nothing. Autopilot is off, so no budget is lowered without you.",
    );
    expect(note.text).toContain(`Review ad budget: ${BUDGET_URL}`);
    expect(note.html).toContain(`href="${BUDGET_URL.replace(/&/g, "&amp;")}"`);
    expect(note.html).toContain(">Review ad budget</a>");
    expect(note.html).toContain("Acme Rentals · Budget watch");
    const pre = /display:none[^>]*>([^<]*)</.exec(note.html)?.[1];
    expect(pre).toBe("Lower 3 daily budgets to stay within $25,000 this month. Zavi changed nothing.");
    expect(pre).not.toBe(note.subject);
    expect(`${note.subject}\n${note.text}\n${note.html}`).not.toMatch(/[\u2013\u2014]|--|&mdash;|&ndash;/);
  });

  it("a company-name read that throws never holds up the warning: it goes out without the company", async () => {
    const out = await runBudgetBrake({ id: "b1", tenant_id: T }, READ, {
      send,
      companyName: async () => {
        throw new Error("tenants read timed out");
      },
    });
    expect(out.status).toBe("warned");
    expect(send).toHaveBeenCalledTimes(1);
    const [, note] = send.mock.calls[0];
    expect(note.subject).toBe("Your ads are on track for $27,000 of your $25,000 budget");
    expect(note.html).toContain(">Budget watch</td>");
    expect(note.html).toContain(BUDGET_URL.replace(/&/g, "&amp;"));
  });

  it("an Autopilot read that failed is not claimed as off", async () => {
    autopilot.value = "throw";
    await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send });
    const [, note] = send.mock.calls[0];
    expect(note.text).not.toContain("Autopilot is off");
    expect(note.text).toContain("Zavi changed nothing, and no budget is lowered without you.");
  });

  it("the warning escapes the company and keeps line breaks out of the subject", () => {
    const p = projectMonth(view(), OVER_ROWS);
    const w = renderBrakeWarning(p, suggestCuts(p), { ...CTX, companyName: "A&B <Ads>\r\nBcc: x@y.z" });
    expect(w.subject).toBe("A&B <Ads> Bcc: x@y.z: ads on track for $27,000 of your $25,000 budget");
    expect(w.html).toContain("A&amp;B &lt;Ads&gt; Bcc: x@y.z · Budget watch");
    expect(w.html).not.toContain("<Ads>");
  });

  it("a cut on a platform Zavi cannot write budgets on says so; a Meta cut stays as it was", () => {
    const p = projectMonth(view(), [
      row({ object_id: "as-meta", name: "Prospecting", budget_usd: 600 }),
      row({ platform: "pinterest", object_id: "pg-1", name: "Pins", budget_usd: 400 }),
    ]);
    const w = renderBrakeWarning(p, suggestCuts(p), CTX);
    const lines = w.text.split("\n");
    const pin = lines.find((l) => l.includes("Pinterest Ads"));
    const meta = lines.find((l) => l.includes('"Prospecting"'));
    expect(pin).toMatch(/^- Pinterest Ads ad group "Pins": \$400\.00 a day to \$\d+\.\d\d a day\. Zavi can't lower this yet\. Change it in Pinterest Ads\.$/);
    expect(meta).toMatch(/^- Meta ad set "Prospecting": \$600\.00 a day to \$\d+\.\d\d a day$/);
    expect(w.html).toContain("Change it in Pinterest Ads.");
  });

  it("a shared-wallet LinkedIn campaign is never sent to LinkedIn Campaign Manager or the ad platform; an own-billing one still is", async () => {
    db.campaigns = [
      row({ platform: "linkedin", account_id: "li_zavi", object_id: "binding-w", name: "Wallet daily", budget_usd: 700 }),
      row({ platform: "linkedin", account_id: "li_zavi", object_id: "binding-wl", name: "Wallet total", budget_kind: "lifetime", budget_usd: 3000 }),
      row({ platform: "linkedin", account_id: "li_own", object_id: "9001", name: "Own daily", budget_usd: 600 }),
      row({ platform: "linkedin", account_id: "li_own", object_id: "9002", name: "Own total", budget_kind: "lifetime", budget_usd: 3000 }),
    ] as unknown as Array<Record<string, unknown>>;
    db.bindings = [
      { id: "binding-w", platform: "linkedin", provider_campaign_id: "5551", funding_source: "wallet" },
      { id: "binding-wl", platform: "linkedin", provider_campaign_id: "5552", funding_source: "wallet" },
      { id: "binding-own", platform: "linkedin", provider_campaign_id: "9001", funding_source: "provider" },
    ];
    await runBudgetBrake({ id: "b1", tenant_id: T }, [{ platform: "linkedin", account_id: "li_zavi" }, { platform: "linkedin", account_id: "li_own" }], { send });
    const [, note] = send.mock.calls[0];
    const lines = note.text.split("\n");
    const walletDaily = lines.find((l) => l.includes('"Wallet daily"'))!;
    const ownDaily = lines.find((l) => l.includes('"Own daily"'))!;
    expect(walletDaily).toContain("Zavi ads balance");
    expect(walletDaily).not.toMatch(/Change it in|Campaign Manager|ad platform/);
    expect(ownDaily).toMatch(/Change it in LinkedIn Ads\.$/);
    const walletTitle = lines.findIndex((l) => l.includes("from your Zavi ads balance, so pause them"));
    const ownTitle = lines.findIndex((l) => l === "Zavi cannot lower these yet. Change them in the ad platform if you need to:");
    expect(lines[walletTitle + 1]).toContain('"Wallet total"');
    expect(lines[ownTitle + 1]).toContain('"Own total"');
    const ownItems = lines.slice(ownTitle + 1, lines.indexOf("", ownTitle));
    expect(ownItems.some((l) => l.includes("Wallet total"))).toBe(false);
  });
  it("a wallet-only over-pace with nothing Zavi can lower does not tell the founder to change it in the ad platform", () => {
    const p = projectMonth(view({ spent_usd: 26000 }), [row({ platform: "linkedin", object_id: "binding-wl", budget_kind: "lifetime", budget_usd: 900 })]);
    const w = renderBrakeWarning(p, suggestCuts(p), { ...CTX, walletObjects: new Set(["linkedin:binding-wl"]) });
    expect(`${w.text}\n${w.html}`).not.toMatch(/in the ad platform|Campaign Manager/);
    expect(w.text).toContain("Zavi ads balance");
  });
  it("no cuts, only budgets Zavi cannot lower: the preheader says to change them in the platform", () => {
    const p = projectMonth(view({ spent_usd: 26000 }), [row({ object_id: "life", budget_kind: "lifetime", budget_usd: 900 })]);
    const w = renderBrakeWarning(p, suggestCuts(p), CTX);
    expect(/display:none[^>]*>([^<]*)</.exec(w.html)?.[1]).toBe(
      "Change 1 budget in the ad platform to stay within $25,000. Zavi changed nothing.",
    );
    expect(w.html).toContain(">Review ad budget</a>");
  });

  it("runs once per day: the second hour sends nothing; the next day checks again", async () => {
    await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send });
    expect(await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).toEqual({ status: "already_checked" });
    expect(send).toHaveBeenCalledTimes(1);
    db.today = "2026-10-21";
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("warned");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("not on track: nothing is sent, and the claim stays so it runs once that day", async () => {
    db.view = view({ spent_usd: 1000 });
    expect(await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).toEqual({ status: "on_track", projected_usd: 13000, cap_usd: 25000 });
    expect(send).not.toHaveBeenCalled();
    expect(db.checkedFor).toBe("2026-10-20");
    expect(db.rpc).not.toContain("release_ad_budget_brake");
  });

  it("an incomplete under-cap projection takes no daily claim and never reports on-track", async () => {
    db.view = view({ spent_usd: 1000 });
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send, incompletePlatforms: ["ChatGPT Ads"] })).status).toBe("read_failed");
    expect(db.rpc).not.toContain("claim_ad_budget_brake");
    expect(send).not.toHaveBeenCalled();
  });
  it("a known over-cap partial read warns with an explicit missing-provider limitation", async () => {
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send, incompletePlatforms: ["ChatGPT Ads"] })).status).toBe("warned");
    expect(send.mock.calls[0][1].text).toContain("ChatGPT Ads could not be read");
    expect(send.mock.calls[0][1].text).toContain("do not prove the whole budget will fit");
  });

  it("a failed send gives the claim back, so the next hour tries again", async () => {
    send.mockRejectedValueOnce(new Error("sendgrid down"));
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("send_failed");
    expect(db.checkedFor).toBeNull();
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("warned");
  });

  it("Autopilot ON: no email, one brake.due event with an idempotent id and the numbers", async () => {
    autopilot.value = true;
    const out = await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send });
    expect(out).toEqual({ status: "brake_due", projected_usd: 27000, cap_usd: 25000 });
    expect(send).not.toHaveBeenCalled();
    expect(inngestSend).toHaveBeenCalledTimes(1);
    expect(inngestSend.mock.calls[0][0]).toEqual({
      name: "ad-budget/brake.due",
      id: "ad-budget-brake:b1:2026-10-20",
      data: { tenant_id: T, budget_id: "b1", projected_usd: 27000, cap_usd: 25000, day: "2026-10-20" },
    });
  });

  it("Autopilot ON: the founder is told directly with the numbers (no cgo run), and a failed alert never fails the brake", async () => {
    autopilot.value = true;
    const alertFounder = vi.fn(async () => {
      throw new Error("mail down");
    });
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send, alertFounder })).status).toBe("brake_due");
    expect(alertFounder).toHaveBeenCalledWith(T, { budget_id: "b1", day: "2026-10-20", projected_usd: 27000, cap_usd: 25000 });
    expect(send).not.toHaveBeenCalled();
  });

  it("Autopilot OFF: the warning email is the founder's message, no direct alert", async () => {
    const alertFounder = vi.fn(async () => undefined);
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send, alertFounder })).status).toBe("warned");
    expect(alertFounder).not.toHaveBeenCalled();
  });

  it("Autopilot ON but the event cannot be sent: the claim is given back", async () => {
    autopilot.value = true;
    inngestSend.mockRejectedValueOnce(new Error("inngest down"));
    const alertFounder = vi.fn(async () => undefined);
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send, alertFounder })).status).toBe("event_failed");
    expect(db.checkedFor).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(alertFounder).not.toHaveBeenCalled();
  });

  it("an Autopilot read error is treated as OFF: the founder is warned, nothing else", async () => {
    autopilot.value = "throw";
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("warned");
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("a read failure: the brake does not run that hour and takes no claim", async () => {
    db.campaignsFail = true;
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("read_failed");
    db.campaignsFail = false;
    db.viewFails = true;
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("read_failed");
    expect(db.rpc).not.toContain("claim_ad_budget_brake");
    expect(db.checkedFor).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("a row with no status reaches the projection and counts (fails closed), a removed row does not", async () => {
    db.view = view({ spent_usd: 0, month_cap_usd: 500, days_left: 20 });
    db.campaigns = [
      row({ platform: "linkedin", object_id: "no-status", budget_usd: 30, status: null }),
      row({ platform: "linkedin", object_id: "gone", budget_usd: 900, status: "removed" }),
    ] as unknown as Array<Record<string, unknown>>;
    const out = await runBudgetBrake({ id: "b1", tenant_id: T }, [{ platform: "linkedin", account_id: "act_1" }], { send });
    expect(out).toMatchObject({ status: "warned", projected_usd: 600, cap_usd: 500 });
  });

  it("a campaign list at its row limit is not trusted (it could under-project)", async () => {
    db.campaigns = Array.from({ length: 1000 }, (_, i) => row({ object_id: `x${i}`, budget_usd: 1 })) as unknown as Array<Record<string, unknown>>;
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("read_failed");
  });

  it("a stopped budget, or another budget than the one reconciled: nothing", async () => {
    db.view = view({ status: "stopped" });
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("no_budget");
    db.view = view({ id: "b2" });
    expect((await runBudgetBrake({ id: "b1", tenant_id: T }, READ, { send })).status).toBe("no_budget");
    expect(db.rpc).not.toContain("claim_ad_budget_brake");
  });
});

describe("creator hires are fixed spend the brake cuts ads around (creator hires S1)", () => {
  it("creator spend + ads raised outside Zavi: the cuts keep ads + creators within the month cap", () => {
    const v = view({ spent_usd: 13000, creator_held_usd: 500, creator_spent_usd: 1500 });
    const p = projectMonth(v, OVER_ROWS);
    expect(p.creator_usd).toBe(2000);
    expect(p.projected_usd).toBe(27000);
    expect(p.over).toBe(true);
    const s = suggestCuts(p);
    expect(s.fits).toBe(true);
    const newDaily = s.cuts.reduce((t, c) => t + c.suggested_usd, 0);
    expect(13000 + 2000 + newDaily * 12).toBeLessThanOrEqual(25000);
    expect(renderBrakeWarning(p, s, CTX).text).toContain("Creator hires this month: $2,000");
  });

  it("no creator fields (an older view) counts as none", () => {
    expect(projectMonth(view({ spent_usd: 13000 }), OVER_ROWS).creator_usd).toBe(0);
  });
});

describe("readLiveMonthProjection: the projection outside the hourly read (control state, Autopilot check, card warning)", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const fresh = "2026-10-20T11:00:05Z";
  beforeEach(() => {
    db.view = view();
    db.viewFails = false;
    db.campaignsFail = false;
    db.rpc = [];
  });

  it("counts the accounts the hourly read refreshed lately, not an account it stopped reading", async () => {
    db.campaigns = [
      { ...row({ object_id: "as-big", budget_usd: 600 }), as_of: fresh },
      { ...row({ platform: "google", object_id: "111", budget_usd: 400, status: "ENABLED" }), as_of: fresh },
      { ...row({ object_id: "as-old", account_id: "act_old", budget_usd: 5000 }), as_of: new Date(NOW.getTime() - LIVE_ACCOUNT_MS - 60_000).toISOString() },
    ];
    const r = await readLiveMonthProjection(T, NOW);
    expect(r).toMatchObject({ budget_id: "b1", projection: { running_daily_usd: 1000, projected_usd: 27000, month_cap_usd: 25000, over: true } });
    expect(db.rpc.filter((n) => n === "ad_budget_month_view")).toHaveLength(1);
  });

  it("no active budget: null, and the campaigns are not read", async () => {
    db.view = null;
    db.campaignsFail = true;
    expect(await readLiveMonthProjection(T, NOW)).toBeNull();
  });

  it("throws on a read error (callers pick their own safe side)", async () => {
    db.campaignsFail = true;
    await expect(readLiveMonthProjection(T, NOW)).rejects.toThrow("ad_campaigns read failed");
  });
});
