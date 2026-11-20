
import type { SiteFunctionsConfig } from "./config";
import type { WorkerModule } from "./bundle";

export const COMPATIBILITY_DATE = "2026-09-01";

export interface UploadInput {
  script: string;
  mainModule: string;
  modules: WorkerModule[];
  secrets: Array<{ name: string; value: string }>;
  tags: string[];
}

export interface WfpApi {
  upload(input: UploadInput): Promise<void>;
  remove(script: string): Promise<void>;
  putSecret(script: string, name: string, value: string): Promise<"ok" | "absent">;
  deleteSecret(script: string, name: string): Promise<"ok" | "absent">;
}

export class CloudflareApiError extends Error {
  constructor(public op: string, public status: number, public cfCode: string | null) {
    super(`cloudflare ${op} failed (${status}${cfCode ? ` ${cfCode}` : ""})`);
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData }) => Promise<{ status: number; text(): Promise<string> }>;

async function cfCode(res: { text(): Promise<string> }): Promise<string | null> {
  try {
    const j = JSON.parse(await res.text()) as { errors?: Array<{ code?: number }> };
    return j.errors?.[0]?.code !== undefined ? String(j.errors[0].code) : null;
  } catch {
    return null;
  }
}

export function createWfpApi(cfg: SiteFunctionsConfig, fetchFn: FetchLike = (u, i) => fetch(u, i as RequestInit) as unknown as ReturnType<FetchLike>): WfpApi {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/workers/dispatch/namespaces/${encodeURIComponent(cfg.namespace)}/scripts`;
  const auth = { Authorization: `Bearer ${cfg.token}` };
  const scriptUrl = (s: string) => {
    if (!/^[a-z0-9-]{1,63}$/.test(s)) throw new Error("invalid script name");
    return `${base}/${s}`;
  };
  return {
    async upload(input) {
      const metadata = {
        main_module: input.mainModule,
        compatibility_date: COMPATIBILITY_DATE,
        bindings: input.secrets.map((s) => ({ type: "secret_text", name: s.name, text: s.value })),
        tags: input.tags,
        tail_consumers: [{ service: cfg.tailWorker }],
        observability: { enabled: false },
      };
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      for (const m of input.modules) {
        form.append(m.name, new Blob([m.content], { type: "application/javascript+module" }), m.name);
      }
      const res = await fetchFn(scriptUrl(input.script), { method: "PUT", headers: auth, body: form });
      if (res.status < 200 || res.status >= 300) throw new CloudflareApiError("upload", res.status, await cfCode(res));
    },
    async remove(script) {
      const res = await fetchFn(`${scriptUrl(script)}?force=true`, { method: "DELETE", headers: auth });
      if (res.status === 404) return;
      if (res.status < 200 || res.status >= 300) throw new CloudflareApiError("delete", res.status, await cfCode(res));
    },
    async putSecret(script, name, value) {
      const res = await fetchFn(`${scriptUrl(script)}/secrets`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name, text: value, type: "secret_text" }),
      });
      if (res.status === 404) return "absent";
      if (res.status < 200 || res.status >= 300) throw new CloudflareApiError("put_secret", res.status, await cfCode(res));
      return "ok";
    },
    async deleteSecret(script, name) {
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("invalid secret name");
      const res = await fetchFn(`${scriptUrl(script)}/secrets/${name}`, { method: "DELETE", headers: auth });
      if (res.status === 404) return "absent";
      if (res.status < 200 || res.status >= 300) throw new CloudflareApiError("delete_secret", res.status, await cfCode(res));
      return "ok";
    },
  };
}
