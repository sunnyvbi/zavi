import type { ConnectorStatus, DbSetup } from "./databaseApi";
import { DB_LABEL } from "./readOnlyScripts";

export type DbTileState = "none" | "cloud" | "legacy" | "connector" | "member-none" | "member-connected";

export function dbTileState(setup: DbSetup | null, canManage: boolean): DbTileState {
  const connected = Boolean(setup?.connected);
  if (!canManage) return connected ? "member-connected" : "member-none";
  if (!setup || !setup.connected) return "none";
  if (setup.mode === "connector") return "connector";
  return setup.legacy ? "legacy" : "cloud";
}

export const CLOUD_MENU = ["What Zavi can see", "Data access log", "Privacy", "Reconnect", "Disconnect"] as const;
export const CONNECTOR_MENU = ["Connector status", "Rules (read-only)", "Data access log", "Remove connector"] as const;
export type DbMenuItem = (typeof CLOUD_MENU)[number] | (typeof CONNECTOR_MENU)[number];

export function dbTileMenu(state: DbTileState): readonly DbMenuItem[] {
  if (state === "cloud" || state === "legacy") return CLOUD_MENU;
  if (state === "connector") return CONNECTOR_MENU;
  return [];
}

export function dbTileDescription(
  state: DbTileState,
  setup: DbSetup | null,
  syncedText?: string | null,
  connector?: ConnectorStatus | null,
): string {
  if (state === "member-none") return "Ask an owner or admin to connect your database";
  if (state === "none") return "Your own product tables. Zavi only reads.";
  if (!setup || !setup.connected) return "Your own product tables. Zavi only reads.";
  if (setup.mode === "connector") {
    const machine = connector && connector.paired ? connector.machine : null;
    return machine ? `Via Zavi Connector · ${machine}` : "Via Zavi Connector";
  }
  if (setup.managed_by === "zavi") return "Your app's database, set up by Zavi";
  const engine = setup.dialect ? (DB_LABEL[setup.dialect] ?? setup.dialect) : "";
  return [engine, syncedText].filter(Boolean).join(" · ") || "Connected";
}

export function connectorTileStatus(connector: ConnectorStatus | null): { tone: "connected" | "warning" | "idle"; text: string } {
  if (!connector) return { tone: "idle", text: "Checking…" };
  if (!connector.paired) return { tone: "warning", text: "Not paired" };
  if (connector.online) return { tone: "connected", text: "Online" };
  return { tone: "warning", text: connector.last_seen_age ? `Offline ${connector.last_seen_age}` : "Offline" };
}

export function whatCanLeaveText(rules: { what_can_leave: string; max_rows: number }): string {
  const what = rules.what_can_leave === "totals_and_counts_only" ? "Totals and counts only" : "Rows, with blocked columns removed";
  return `${what}, max ${rules.max_rows} rows`;
}

export function unencryptedWarning(dialect: string | null | undefined, transport: string | null | undefined): { title: string; body: string } | null {
  if (transport !== "plaintext") return null;
  const how: Record<string, string> = {
    mysql: "Turn on TLS on your MySQL server, then choose Reconnect and paste the login without ssl=false.",
    mongodb: "Turn on TLS on your MongoDB server, then choose Reconnect and paste the login without tls=false.",
    postgres: "Turn on SSL on your Postgres server, then choose Reconnect and paste the login without sslmode=disable.",
  };
  return {
    title: "Unencrypted connection",
    body: `Zavi reads this database without encryption, so query results cross the network in plain text. ${how[dialect ?? ""] ?? "Turn on TLS for your database, then choose Reconnect and paste the login again."} New logins need an encrypted connection.`,
  };
}
