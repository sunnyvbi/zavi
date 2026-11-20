
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createClient } from "@supabase/supabase-js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  meta?: Record<string, string | number>;
  fix?: string;
};

export function checkUptime(): Check {
  const uptimeSec = process.uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  return {
    name: "uptime",
    status: "ok",
    detail: `process up for ${days}d ${hours}h`,
    meta: { ms: Math.round(uptimeSec * 1000) },
  };
}

export async function checkSecrets(): Promise<Check> {
  const roleId = process.env.PRAXIS_SECRETS_SECRET_ID;
  if (!roleId) {
    return {
      name: "secrets",
      status: "skip",
      detail:
        "PRAXIS_SECRETS_SECRET_ID not set — not running inside the backend container",
    };
  }
  const env = process.env.NODE_ENV || "production";
  const commonMap: Record<string, string> = {
    production: "praxis-env-common-prod",
    staging: "praxis-env-common-staging",
  };
  const commonId = commonMap[env];

  const client = new SecretsManagerClient({});
  const fetchKeys = async (
    id: string,
  ): Promise<{ keys: Set<string>; modifiedAt?: Date }> => {
    const value = await client.send(new GetSecretValueCommand({ SecretId: id }));
    const raw = value.SecretString ?? "";
    const keys = new Set<string>();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const k of Object.keys(parsed)) keys.add(k);
      }
    } catch {
      for (const line of raw.split("\n")) {
        const m = line.match(/^([A-Z0-9_]+)=/);
        if (m) keys.add(m[1]);
      }
    }
    return { keys, modifiedAt: value.CreatedDate };
  };

  const role = await fetchKeys(roleId);
  const common = commonId
    ? await fetchKeys(commonId).catch((e: { name?: string }) => {
        if (e?.name === "ResourceNotFoundException") return { keys: new Set<string>(), modifiedAt: undefined as Date | undefined };
        throw e;
      })
    : { keys: new Set<string>(), modifiedAt: undefined as Date | undefined };
  const expected = new Set<string>([...role.keys, ...common.keys]);
  const missing: string[] = [];
  for (const k of expected) {
    if (process.env[k] === undefined) missing.push(k);
  }
  missing.sort();

  const lastModified = [role.modifiedAt, common.modifiedAt]
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const containerStartedAt = new Date(Date.now() - process.uptime() * 1000);
  const driftSeconds = lastModified
    ? Math.max(
        0,
        Math.floor(
          (lastModified.getTime() - containerStartedAt.getTime()) / 1000,
        ),
      )
    : 0;

  if (missing.length > 0) {
    return {
      name: "secrets",
      status: "fail",
      detail: `${missing.length} key(s) in Secrets Manager but missing from process.env: ${missing.join(", ")}`,
      meta: { count: missing.length },
      fix: `aws secretsmanager get-secret-value --secret-id $PRAXIS_SECRETS_SECRET_ID --query SecretString --output text | grep -E '^(${missing.join("|")})='
# Secrets load at boot on BOTH hosts: restart the API host and the worker host.
ssh ubuntu@184.169.192.250 'docker restart praxis-backend'
ssh ubuntu@54.241.199.146 'docker restart praxis-backend'   # worker; re-syncs Inngest on boot`,
    };
  }
  if (driftSeconds > 0) {
    return {
      name: "secrets",
      status: "warn",
      detail: `Secrets Manager last modified ${driftSeconds}s AFTER container start — restart to pick up changes`,
      meta: { count: expected.size },
      fix: `# Secrets load at boot on BOTH hosts: restart the API host and the worker host.
ssh ubuntu@184.169.192.250 'docker restart praxis-backend'
ssh ubuntu@54.241.199.146 'docker restart praxis-backend'   # worker; re-syncs Inngest on boot`,
    };
  }
  return {
    name: "secrets",
    status: "ok",
    detail: `${expected.size} keys expected, all present; no drift since container start`,
    meta: { count: expected.size },
  };
}

export async function checkDb(): Promise<Check> {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !svc || !anon) {
    return {
      name: "db",
      status: "fail",
      detail: "SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY missing",
      fix: "fix secrets check first",
    };
  }
  const sc = createClient(url, svc, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ac = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const [svcRes, anonRes] = await Promise.all([
    sc.from("tenants").select("id").limit(1),
    ac.from("tenants").select("id").limit(1),
  ]);
  if (svcRes.error) {
    return {
      name: "db",
      status: "fail",
      detail: `service-role: ${svcRes.error.message}`,
    };
  }
  if (anonRes.error && anonRes.error.code !== "PGRST301") {
    return {
      name: "db",
      status: "warn",
      detail: `anon: ${anonRes.error.message}`,
    };
  }
  return {
    name: "db",
    status: "ok",
    detail: "service-role + anon both reachable",
  };
}

export async function checkInngest(): Promise<Check> {
  const eventKey = process.env.INNGEST_EVENT_KEY;
  const signingKey = process.env.INNGEST_SIGNING_KEY;
  if (!eventKey || !signingKey) {
    return {
      name: "inngest",
      status: "skip",
      detail: "INNGEST_EVENT_KEY or INNGEST_SIGNING_KEY not set",
    };
  }

  const nonce = `doctor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sentAt = Date.now();

  const sendRes = await fetch(`https://inn.gs/e/${eventKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ping", data: { correlation_id: nonce } }),
  });
  if (!sendRes.ok) {
    return {
      name: "inngest",
      status: "fail",
      detail: `event ingestion failed: HTTP ${sendRes.status}`,
      meta: { http_status: sendRes.status, error_class: "EventIngestFailed" },
      fix: "check INNGEST_EVENT_KEY is current; rotate in Inngest dashboard if compromised",
    };
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const evRes = await fetch(
      `https://api.inngest.com/v1/events?name=pong&limit=20`,
      { headers: { Authorization: `Bearer ${signingKey}` } },
    );
    if (!evRes.ok) continue;
    const body = (await evRes.json()) as {
      data?: Array<{ name: string; data?: { correlation_id?: string } }>;
    };
    const match = (body.data ?? []).find(
      (e) => e.data?.correlation_id === nonce,
    );
    if (match) {
      const ms = Date.now() - sentAt;
      return {
        name: "inngest",
        status: "ok",
        detail: `ping/pong round-trip ok in ${ms}ms (correlation=${nonce.slice(-6)})`,
        meta: { ms },
      };
    }
  }

  return {
    name: "inngest",
    status: "fail",
    detail:
      "ping sent but no pong observed within 30s — registration drift suspected",
    meta: { ms: 30_000, error_class: "InngestRegistrationDrift" },
    fix: `# Inngest runs on the worker host (jobs.zaviagent.com). Restart it; it re-syncs on boot.
ssh ubuntu@54.241.199.146 'docker restart praxis-backend'
# Then check the Inngest dashboard app URL is https://jobs.zaviagent.com/api/inngest.
# Never PUT /api/inngest as a probe: the last PUT wins and can move every job.
# Wait 30s + re-run doctor to confirm`,
  };
}

export async function guardCheck(name: string, run: () => Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (e) {
    const errorClass = (e as { name?: string })?.name || "Error";
    return {
      name,
      status: "fail",
      detail: `check threw ${errorClass}`,
      meta: { error_class: errorClass.slice(0, 64) },
    };
  }
}

export async function runDoctorChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(checkUptime());
  checks.push(await guardCheck("secrets", checkSecrets));
  checks.push(await guardCheck("db", checkDb));
  checks.push(await guardCheck("inngest", checkInngest));
  return checks;
}
