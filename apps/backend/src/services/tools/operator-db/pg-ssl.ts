
import type { ClientConfig } from "pg";

export function pgSslOption(connectionString: string): ClientConfig["ssl"] {
  return sslModeOf(connectionString) === "disable" ? false : { rejectUnauthorized: false };
}

export function sslModeOf(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    const mode = url.searchParams.get("sslmode");
    return mode ? mode.toLowerCase() : null;
  } catch {
    return sslModeFromDsn(connectionString);
  }
}

function sslModeFromDsn(dsn: string): string | null {
  let i = 0;
  const n = dsn.length;
  const readValue = (): string => {
    if (dsn[i] === "'") {
      i++;
      let v = "";
      while (i < n && dsn[i] !== "'") {
        if (dsn[i] === "\\") i++;
        if (i < n) v += dsn[i];
        i++;
      }
      i++;
      return v;
    }
    let v = "";
    while (i < n && !/\s/.test(dsn[i])) {
      if (dsn[i] === "\\") i++;
      if (i < n) v += dsn[i];
      i++;
    }
    return v;
  };

  while (i < n) {
    while (i < n && /\s/.test(dsn[i])) i++;
    let key = "";
    while (i < n && !/[\s=]/.test(dsn[i])) key += dsn[i++];
    while (i < n && /\s/.test(dsn[i])) i++;
    if (dsn[i] !== "=") {
      if (key.length === 0) i++;
      continue;
    }
    i++;
    while (i < n && /\s/.test(dsn[i])) i++;
    const value = readValue();
    if (key.toLowerCase() === "sslmode") return value.toLowerCase() || null;
  }
  return null;
}
