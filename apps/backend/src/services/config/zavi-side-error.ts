
import type { McpCallResult } from "@/services/mcp/types";
import type { AlertInput } from "@/services/logging/alert";
import { errorCodeFromContent } from "@/services/tools/types";
import { envLabel, platformKeyFor, type PlatformKeyEntry } from "./platform-keys";

export function zaviSideNotice(entry: PlatformKeyEntry): string {
  return (
    `ZAVI-SIDE SETUP GAP. This is not the user's job and they cannot fix it; the Zavi team has been alerted automatically. ` +
    `Tell the user plainly: you can't ${entry.feature} right now, that is a setup gap on Zavi's side and nothing they need to do, ` +
    `the Zavi team has been told, and they can ask you again later and you'll retry. Then carry on with whatever you can do without it. ` +
    `Never ask them to contact anyone, add or set a key, or connect anything for this, and never make it a task, card or to-do for them.`
  );
}

type Deps = {
  alert: (input: AlertInput) => Promise<void>;
  now: () => Date;
};

const alerted = new Map<string, string>();

export function resetZaviSideAlerts(): void {
  alerted.clear();
}

function noteZaviSide(
  entry: PlatformKeyEntry,
  ctx: { tenant_id?: string; run_id?: string; agent_slug?: string },
  server_id: string,
  tool_name: string,
  deps: Deps,
): void {
  const code = entry.code as string;
  const day = deps.now().toISOString().slice(0, 10);
  if (alerted.get(code) === day) return;
  alerted.set(code, day);
  const keys = entry.env.length ? envLabel(entry.env) : "(account setting, no env key)";
  void deps
    .alert({
      source: "platform-key-missing",
      code,
      tenant_id: ctx.tenant_id ?? null,
      msg: `A run hit ${code}: Zavi cannot ${entry.feature}. Key: ${keys}.`,
      email: {
        dedupeKey: `platform_config:${code}:${day}`,
        subjectDetail: `Zavi-side gap: ${code}`,
        detail: [
          `Error: ${code}`,
          `Key: ${keys}`,
          `Tool: ${server_id}/${tool_name}`,
          `Agent: ${ctx.agent_slug ?? "unknown"}`,
          `Run: ${ctx.run_id ?? "unknown"} (tenant ${ctx.tenant_id ?? "unknown"})`,
          "",
          "The user was told it is on Zavi's side. Fix: add the key to AWS Secrets Manager praxis-envprod-1,",
          "then restart BOTH the api and worker containers.",
          "One email per error code per day while it keeps happening.",
        ].join("\n"),
        required: true,
      },
    })
    .catch((e: unknown) => {
      if (alerted.get(code) === day) alerted.delete(code);
      console.warn(`[zavi-side-error] alert failed for ${code}: ${(e as Error).message}`);
    });
}

export function withZaviSideNotice(
  ctx: { tenant_id?: string; run_id?: string; agent_slug?: string },
  server_id: string,
  tool_name: string,
  res: McpCallResult,
  deps: Partial<Deps> = {},
): McpCallResult {
  try {
    if (!res.is_error && res.ok !== false) return res;
    const entry = platformKeyFor(errorCodeFromContent(res.content));
    if (!entry) return res;
    const body = JSON.parse(String(res.content)) as { message?: unknown; meta?: unknown };
    const original = typeof body.message === "string" ? body.message : "";
    const notice = zaviSideNotice(entry);
    const meta = body.meta && typeof body.meta === "object" ? { ...(body.meta as Record<string, unknown>) } : {};
    delete meta.unblockers;
    const content = JSON.stringify({
      ...body,
      message: entry.keepMessage && original ? `${notice}\n\n${original}` : notice,
      meta: { ...meta, owner: "zavi", next_step: "zavi_alerted" },
    });
    noteZaviSide(entry, ctx, server_id, tool_name, {
      alert: deps.alert ?? (async (input) => (await import("@/services/logging/alert")).alert(input)),
      now: deps.now ?? (() => new Date()),
    });
    return { ...res, content };
  } catch {
    return res;
  }
}
