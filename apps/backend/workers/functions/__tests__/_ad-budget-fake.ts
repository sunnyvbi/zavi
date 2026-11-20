
type Res = {
  platform: string;
  object_id: string | null;
  op: string;
  delta: number;
  amount: number;
  status: "reserved" | "committed" | "released" | "refused";
  released_today: boolean;
  paused?: boolean;
  ref?: unknown;
};

export type AdBudgetFakeOpts = {
  cap?: number;
  spent?: number;
  days?: number;
  margin?: number;
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function monthViewOf(
  rows: Array<Record<string, unknown>> | undefined,
  tenant_id: unknown,
): Record<string, unknown> | null {
  const mine = (rows ?? []).filter((r) => r.tenant_id === tenant_id);
  const b = mine.find((r) => r.status === "active") ?? mine[mine.length - 1];
  if (!b) return null;
  const cap = Number(b.month_cap_usd ?? b.monthly_usd ?? 1000);
  const spent = Number(b.spent_usd ?? 0);
  const held = Number(b.held_usd ?? 0);
  return {
    id: b.id,
    status: b.status,
    monthly_usd: Number(b.monthly_usd ?? cap),
    daily_limit_usd: b.daily_limit_usd ?? null,
    started_on: "2026-09-01",
    created_at: "2026-09-01T00:00:00Z",
    stopped_at: null,
    month_start: "2026-09-01",
    next_month_start: "2026-10-01",
    days_left: 10,
    days_in_month: 30,
    month_cap_usd: cap,
    spent_usd: spent,
    held_usd: held,
    left_usd: Math.max(cents(cap - spent - held), 0),
  };
}

export function makeAdBudgetFake(opts: AdBudgetFakeOpts | null) {
  const res = new Map<string, Res>();
  const budget =
    opts === null
      ? null
      : {
          cap: opts.cap ?? 1000,
          spent: opts.spent ?? 0,
          days: opts.days ?? 10,
          margin: opts.margin ?? 1.25,
          get held(): number {
            let daily = 0;
            let today = 0;
            for (const r of res.values()) {
              if ((r.status === "reserved" || r.status === "committed") && r.paused) today += r.delta;
              else if (r.status === "reserved" || r.status === "committed") daily += r.delta;
              else if (r.status === "released" && r.released_today) today += r.delta;
            }
            return cents((daily * this.days + today) * this.margin);
          },
        };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let failWith: string | null = null;

  let stopped = false;
  let viewReads = 0;
  let stopAfterViewReads: number | undefined;

  const adChanges: Array<Record<string, unknown>> = [];

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name === "record_ad_object_changes") {
      const rows = (args.p_changes ?? []) as Array<Record<string, unknown>>;
      adChanges.push(...rows);
      return { data: { status: "recorded", inserted: rows.length }, error: null };
    }
    calls.push({ name, args });
    if (failWith) return { data: null, error: { message: failWith } };
    if (name === "ad_budget_month_view") {
      const view =
        budget && !stopped
          ? {
              id: "budget-1",
              status: "active",
              monthly_usd: budget.cap,
              daily_limit_usd: null,
              started_on: "2026-09-01",
              created_at: "2026-09-01T00:00:00Z",
              stopped_at: null,
              month_start: "2026-09-01",
              next_month_start: "2026-10-01",
              days_left: budget.days,
              days_in_month: 30,
              month_cap_usd: budget.cap,
              spent_usd: budget.spent,
              held_usd: budget.held,
              left_usd: Math.max(cents(budget.cap - budget.spent - budget.held), 0),
            }
          : null;
      viewReads++;
      if (stopAfterViewReads !== undefined && viewReads >= stopAfterViewReads) stopped = true;
      return { data: view, error: null };
    }
    if (!budget || stopped) {
      return { data: { status: "no_budget", amount_usd: 0, reason: null }, error: null };
    }
    if (name === "reserve_ad_spend") {
      const key = String(args.p_idem_key);
      let delta = Number(args.p_daily_delta_usd);
      if (args.p_op === "resume") {
        const held = [...res.values()]
          .filter((r) => r.platform === args.p_platform && r.object_id === args.p_object_id)
          .filter((r) => r.status === "reserved" || r.status === "committed")
          .reduce((s, r) => s + r.delta, 0);
        delta = Math.max(delta - held, 0);
      }
      const paused = args.p_paused === true && args.p_op === "create";
      let amount = cents(delta * (paused ? 1 : budget.days) * budget.margin);
      const unpause =
        args.p_op === "resume"
          ? [...res.entries()]
              .filter(([k, r]) => k !== key && r.paused && r.platform === args.p_platform && r.object_id === args.p_object_id)
              .filter(([, r]) => r.status === "reserved" || r.status === "committed")
              .map(([, r]) => r)
          : [];
      const extra = cents(unpause.reduce((s, r) => s + r.delta, 0) * Math.max(budget.days - 1, 0) * budget.margin);
      amount = cents(amount + extra);
      const prior = res.get(key);
      if (prior && (prior.status === "reserved" || prior.status === "committed")) {
        return { data: { status: "already_held", amount_usd: prior.amount, reason: null }, error: null };
      }
      const heldBefore = budget.held;
      const row: Res = {
        platform: String(args.p_platform),
        object_id: (args.p_object_id as string | null) ?? null,
        op: String(args.p_op),
        delta,
        amount,
        status: "reserved",
        released_today: false,
        ...(paused ? { paused: true } : {}),
      };
      res.set(key, row);
      if ((delta > 0 || extra > 0) && budget.spent + heldBefore + amount > budget.cap) {
        row.status = "refused";
        return { data: { status: "refused", amount_usd: amount, reason: "over_month" }, error: null };
      }
      for (const r of unpause) r.paused = false;
      return { data: { status: "held", amount_usd: amount, reason: null, month_cap_usd: budget.cap }, error: null };
    }
    if (name === "settle_ad_spend") {
      const row = res.get(String(args.p_idem_key));
      if (!row) return { data: { status: "not_found" }, error: null };
      if (row.status !== "reserved") return { data: { status: row.status }, error: null };
      if (args.p_outcome === "committed") {
        row.status = "committed";
        row.object_id = row.object_id ?? ((args.p_object_id as string | null) ?? null);
        return { data: { status: "committed" }, error: null };
      }
      row.status = "released";
      return { data: { status: "released" }, error: null };
    }
    if (name === "note_ad_spend_ref") {
      const row = res.get(String(args.p_idem_key));
      if (!row) return { data: { status: "not_found" }, error: null };
      const same = JSON.stringify(row.ref ?? null) === JSON.stringify(args.p_ref);
      if (row.status === "reserved" && row.object_id === null && (row.ref === undefined || same)) {
        row.ref = args.p_ref;
        return { data: { status: "noted" }, error: null };
      }
      if ((row.status === "reserved" || row.status === "committed") && row.object_id !== null)
        return { data: { status: "unchanged" }, error: null };
      return { data: { status: "not_open" }, error: null };
    }
    if (name === "note_ad_spend_object") {
      const row = res.get(String(args.p_idem_key));
      if (!row) return { data: { status: "not_found" }, error: null };
      if (row.status !== "reserved" || row.object_id !== null) return { data: { status: "unchanged" }, error: null };
      row.object_id = String(args.p_object_id);
      return { data: { status: "noted" }, error: null };
    }
    if (name === "release_ad_spend_for_object") {
      let daily = 0;
      for (const row of res.values()) {
        if (row.platform !== args.p_platform || row.object_id !== args.p_object_id) continue;
        if (row.status !== "committed") continue;
        row.status = "released";
        row.released_today = true;
        daily += row.delta;
      }
      return { data: { status: "released", released_usd: cents(daily * (budget.days - 1) * budget.margin) }, error: null };
    }
    if (name === "rebase_ad_spend_for_object") {
      const key = String(args.p_idem_key);
      if (res.has(key)) return { data: { status: "already_rebased" }, error: null };
      const mine = [...res.values()].filter((r) => r.platform === args.p_platform && r.object_id === args.p_object_id);
      if (mine.some((r) => r.status === "reserved")) return { data: { status: "object_busy" }, error: null };
      const committed = mine.filter((r) => r.status === "committed");
      const held = cents(committed.reduce((s, r) => s + r.delta, 0));
      if (held === 0) return { data: { status: "no_hold" }, error: null };
      let next = Math.ceil(Number(args.p_new_daily_usd) * 100) / 100;
      if (args.p_cut_usd != null) next = Math.max(cents(held - Math.floor(Number(args.p_cut_usd) * 100) / 100), 0);
      if (next >= held) return { data: { status: "not_lower", daily_usd: held }, error: null };
      for (const r of committed) {
        r.status = "released";
        r.released_today = true;
      }
      res.set(key, {
        platform: String(args.p_platform),
        object_id: String(args.p_object_id),
        op: "rebase",
        delta: next,
        amount: cents(next * budget.days * budget.margin),
        status: "committed",
        released_today: false,
      });
      return { data: { status: "rebased", daily_usd: next, released_daily_usd: held }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  }

  return {
    rpc,
    stopAfterViewReads(n: number | undefined) {
      stopAfterViewReads = n;
    },
    stop() {
      stopped = true;
    },
    calls,
    adChanges,
    res,
    budget,
    failRpc(message: string) {
      failWith = message;
    },
    heldDaily(platform: string, object_id: string): number {
      return cents(
        [...res.values()]
          .filter((r) => r.platform === platform && r.object_id === object_id)
          .filter((r) => r.status === "reserved" || r.status === "committed")
          .reduce((s, r) => s + r.delta, 0),
      );
    },
    namesCalled: () =>
      calls.map((c) => c.name).filter((n) => n !== "ad_budget_month_view" && n !== "note_ad_spend_ref"),
  };
}
