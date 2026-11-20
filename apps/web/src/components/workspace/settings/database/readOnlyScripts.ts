
export type ScriptDb = "postgres" | "mysql";

export const MONGO_NO_SCRIPT = "MongoDB can't block single fields for a login, so Zavi enforces hidden fields.";
export type Script = { script: string; refused: string[] };

export const DB_LABEL: Record<string, string> = {
  postgres: "Postgres",
  mysql: "MySQL",
  mongodb: "MongoDB",
  dynamodb: "DynamoDB",
};

export const REFUSED_NAME_NOTE = "This name can't be used in a script, remove it by hand";

export const DB_NAME_PLACEHOLDER = "your_database";
const LOGIN = "zavi_reader";
const MYSQL_LOGIN = "'zavi_reader'@'%'";
const PASSWORD = "'pick-a-long-password'";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function usableName(name: string): boolean {
  return name.length > 0 && name.length <= 512 && !CONTROL.test(name);
}

export function pgIdent(name: string): string {
  return name
    .split(".")
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join(".");
}

function pgCol(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function myIdent(name: string): string {
  return name
    .split(".")
    .map((p) => `\`${p.replace(/`/g, "``")}\``)
    .join(".");
}

function myCol(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function partition(names: string[]): { ok: string[]; refused: string[] } {
  const ok: string[] = [];
  const refused: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!raw.length) continue;
    if (n && usableName(raw)) ok.push(n);
    else refused.push(raw);
  }
  return { ok, refused };
}

export function loginScript(
  db: ScriptDb,
  dbName: string,
  mode: "all" | "pick",
  tables: string[],
): Script {
  const name = dbName.trim() && usableName(dbName) ? dbName.trim() : DB_NAME_PLACEHOLDER;
  const t = partition(tables);
  const refused = [...t.refused];

  if (db === "postgres") {
    const grant =
      mode === "all"
        ? `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${LOGIN};`
        : t.ok.length
          ? `GRANT SELECT ON ${t.ok.map(pgIdent).join(", ")} TO ${LOGIN};`
          : "-- List the tables Zavi may read above.";
    return {
      refused,
      script: `-- 1. A login that can only read
CREATE ROLE ${LOGIN} WITH LOGIN PASSWORD ${PASSWORD};
ALTER ROLE ${LOGIN} SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE ${pgCol(name)} TO ${LOGIN};
GRANT USAGE ON SCHEMA public TO ${LOGIN};

-- 2. What it may read
${grant}`,
    };
  }

  if (db === "mysql") {
    const grants =
      mode === "all"
        ? `GRANT SELECT ON ${myCol(name)}.* TO ${MYSQL_LOGIN};`
        : t.ok.length
          ? t.ok.map((x) => `GRANT SELECT ON ${myCol(name)}.${myCol(x)} TO ${MYSQL_LOGIN};`).join("\n")
          : "-- List the tables Zavi may read above.";
    return {
      refused,
      script: `-- 1. A login that can only read
CREATE USER ${MYSQL_LOGIN} IDENTIFIED BY ${PASSWORD};

-- 2. What it may read
${grants}`,
    };
  }

  return { refused, script: "" };
}

export function removeScript(db: string, table: string, hiddenCols: string[], allCols: string[]): Script {
  if (!usableName(table)) return { script: "", refused: [table] };
  const h = partition(hiddenCols);
  const refused = [...h.refused];
  if (h.ok.length === 0) return { script: "", refused };

  if (db !== "postgres" && db !== "mysql") return { script: "", refused };

  const mysql = db === "mysql";
  const tbl = mysql ? myIdent(table) : pgIdent(table);
  const col = mysql ? myCol : pgCol;
  const login = mysql ? MYSQL_LOGIN : LOGIN;
  const hidden = new Set(h.ok);
  const k = partition(allCols.filter((c) => !hidden.has(c.trim())));
  refused.push(...k.refused);
  if (k.ok.length === 0) {
    return { refused, script: `-- Zavi's login keeps no column of this table\nREVOKE SELECT ON ${tbl} FROM ${login};` };
  }
  return {
    refused,
    script: `-- Zavi's login keeps every other column of this table, but not the hidden ones
REVOKE SELECT ON ${tbl} FROM ${login};
GRANT SELECT (${k.ok.map(col).join(", ")}) ON ${tbl} TO ${login};`,
  };
}
