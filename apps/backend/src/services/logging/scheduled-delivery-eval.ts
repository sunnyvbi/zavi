
export const DELIVERED_STATUSES = new Set(["success", "done"]);
export const MISS_STATUSES = new Set(["failed", "parse_failed", "dispatch_error"]);
export const SCHED_TERMINAL_STATUSES = new Set([
  ...DELIVERED_STATUSES,
  ...MISS_STATUSES,
]);

export const DEFAULT_DELIVERY_THRESHOLD = 0.95;
export const DEFAULT_MIN_TERMINAL_PER_AGENT = 5;
export const DEFAULT_MIN_TERMINAL_GLOBAL = 10;

export type SchedRunRow = { agent_slug: string | null; status: string | null };

export type AgentDeliveryStat = {
  agent_slug: string;
  terminal: number;
  delivered: number;
  missed: number;
  rate: number;
};

export type DeliveryReport = {
  global: { terminal: number; delivered: number; missed: number; rate: number };
  perAgent: AgentDeliveryStat[];
  alarmedAgents: AgentDeliveryStat[];
  globalAlarmed: boolean;
};

export type DeliveryThresholdOpts = {
  deliveryThreshold?: number;
  minTerminalPerAgent?: number;
  minTerminalGlobal?: number;
};

function rate(delivered: number, terminal: number): number {
  return terminal > 0 ? delivered / terminal : 1;
}

export function computeDeliveryReport(
  rows: SchedRunRow[],
  opts: DeliveryThresholdOpts = {},
): DeliveryReport {
  const threshold = opts.deliveryThreshold ?? DEFAULT_DELIVERY_THRESHOLD;
  const minPerAgent = opts.minTerminalPerAgent ?? DEFAULT_MIN_TERMINAL_PER_AGENT;
  const minGlobal = opts.minTerminalGlobal ?? DEFAULT_MIN_TERMINAL_GLOBAL;

  const byAgent = new Map<string, { terminal: number; delivered: number; missed: number }>();
  let gTerminal = 0;
  let gDelivered = 0;
  let gMissed = 0;

  for (const r of rows) {
    const status = r.status ?? "";
    if (!SCHED_TERMINAL_STATUSES.has(status)) continue;
    const slug = r.agent_slug ?? "(unknown)";
    const agg = byAgent.get(slug) ?? { terminal: 0, delivered: 0, missed: 0 };
    agg.terminal += 1;
    gTerminal += 1;
    if (DELIVERED_STATUSES.has(status)) {
      agg.delivered += 1;
      gDelivered += 1;
    } else {
      agg.missed += 1;
      gMissed += 1;
    }
    byAgent.set(slug, agg);
  }

  const perAgent: AgentDeliveryStat[] = [...byAgent.entries()]
    .map(([agent_slug, a]) => ({
      agent_slug,
      terminal: a.terminal,
      delivered: a.delivered,
      missed: a.missed,
      rate: rate(a.delivered, a.terminal),
    }))
    .sort((x, y) => x.rate - y.rate);

  const alarmedAgents = perAgent.filter(
    (a) => a.terminal >= minPerAgent && a.rate < threshold,
  );

  const globalRate = rate(gDelivered, gTerminal);
  const globalAlarmed = gTerminal >= minGlobal && globalRate < threshold;

  return {
    global: { terminal: gTerminal, delivered: gDelivered, missed: gMissed, rate: globalRate },
    perAgent,
    alarmedAgents,
    globalAlarmed,
  };
}
