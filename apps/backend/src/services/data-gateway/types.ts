import { ExpectedToolError } from "@/services/tools/types";

export type GatewayCaller =
  | { kind: "agent"; agent_slug: string | null; run_id: string | null; tool_name: string }
  | { kind: "background"; feature: string }
  | { kind: "person"; user_id: string; feature: "Contact import" | "Table browser" | "Connection test" };

export type GatewayContext = { tenant_id: string; caller: GatewayCaller };

export type GatewayMode = "direct" | "connector";

export type AccessNote = {
  log_id: string | null;
  mode: GatewayMode;
  tables: string[];
  rows: number;
  result: "allowed" | "refused" | "failed";
  refused_by?: "zavi" | "connector";
  refused_rule?: "settings";
  reason?: string;
  totals_only?: boolean;
};

export class GatewayRefusal extends ExpectedToolError {
  constructor(
    public readonly reason: string,
    public readonly refused_by: "zavi" | "connector",
    public readonly tables: string[] = [],
    opts: { totals_only?: boolean; rule?: "settings" } = {},
  ) {
    const who = refused_by === "connector" ? "Refused by your connector" : "Refused by a data-access rule";
    const hint = opts.totals_only ? " Use operator_db__summary." : "";
    super("data_access_refused", `${who}: ${reason}${hint}`, { refused_by, tables });
    this.name = "GatewayRefusal";
    this.rule = opts.rule;
  }
  public readonly rule?: "settings";
}

export class ConnectorOfflineError extends ExpectedToolError {
  constructor(machine: string | null, ageText: string | null) {
    const where = machine ? `The Zavi Connector on ${machine}` : "The Zavi Connector";
    const since = ageText ? ` (offline ${ageText})` : "";
    super(
      "connector_offline",
      `${where} is offline${since}, so Zavi can't read this workspace's database right now. Tell the user their connector is offline. If they asked you to answer without their data, do that.`,
    );
    this.name = "ConnectorOfflineError";
  }
}

export class DatabaseUnreachableError extends ExpectedToolError {
  constructor(message: string) {
    super("operator_db_unreachable", message);
    this.name = "DatabaseUnreachableError";
  }
}

export class AuditUnavailableError extends ExpectedToolError {
  constructor() {
    super(
      "audit_unavailable",
      "Zavi could not record this read in the data access log, so it did not run. Try again shortly.",
    );
    this.name = "AuditUnavailableError";
  }
}

export class DbSourceChangedError extends ExpectedToolError {
  constructor() {
    super(
      "db_source_changed",
      "The database connection or its privacy settings changed while this read was running, so Zavi discarded the result. Run the read again.",
      { next_step: "auto", retryable: true },
    );
    this.name = "DbSourceChangedError";
  }
}

export function callerLabel(c: GatewayCaller): string {
  if (c.kind === "agent") return c.agent_slug ?? "Zavi";
  if (c.kind === "background") return `Zavi (background) · ${c.feature}`;
  return c.feature;
}
