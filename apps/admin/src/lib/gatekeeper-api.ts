
import { adminApiFetch } from "@/lib/api-admin";

export type CachePolicy = "critical" | "standard";

export type GatekeeperFlag = {
  name: string;
  description: string;
  is_enabled: boolean;
  rollout_percentage: number;
  cache_policy: CachePolicy;
  whitelist: string[];
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

export type FlagInput = Partial<
  Pick<GatekeeperFlag, "description" | "is_enabled" | "rollout_percentage" | "cache_policy" | "whitelist">
>;

export type CheckResult = {
  name: string;
  user_id: string | null;
  enabled: boolean;
  reason: string;
  bucket: number | null;
};

const BASE = "/api/admin/gatekeeper";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await adminApiFetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const enc = encodeURIComponent;

export const gatekeeperApi = {
  list: () => call<{ flags: GatekeeperFlag[] }>("/flags").then((r) => r.flags),
  get: (name: string) => call<{ flag: GatekeeperFlag }>(`/flags/${enc(name)}`).then((r) => r.flag),
  create: (name: string, input: FlagInput) =>
    call<{ flag: GatekeeperFlag }>("/flags", { method: "POST", body: JSON.stringify({ name, ...input }) }).then(
      (r) => r.flag,
    ),
  update: (name: string, input: FlagInput) =>
    call<{ flag: GatekeeperFlag }>(`/flags/${enc(name)}`, { method: "PUT", body: JSON.stringify(input) }).then(
      (r) => r.flag,
    ),
  setEnabled: (name: string, isEnabled: boolean) =>
    call<{ flag: GatekeeperFlag }>(`/flags/${enc(name)}/toggle`, {
      method: "PATCH",
      body: JSON.stringify({ is_enabled: isEnabled }),
    }).then((r) => r.flag),
  remove: (name: string) => call<{ deleted: boolean }>(`/flags/${enc(name)}`, { method: "DELETE" }),
  check: (name: string, userId: string) =>
    call<CheckResult>(`/check/${enc(name)}?user_id=${enc(userId)}`),
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLAG_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
