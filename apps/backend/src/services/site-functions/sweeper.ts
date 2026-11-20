
import type { WfpApi } from "./cf-api";
import { fnSiteKey } from "./deploy";
import { dropPrincipalRecord, type FnKv } from "./principals";
import type { SiteFunctionsStore } from "./store";

export interface SweepDeps {
  store: SiteFunctionsStore;
  wfp: () => WfpApi;
  kv: FnKv;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
  reconcile?: (site_id: string) => Promise<unknown>;
}

export async function stopSiteFunctions(
  deps: Pick<SweepDeps, "store" | "kv" | "log"> & {
    hasFunctionState?: (site_id: string) => Promise<boolean>;
  },
  site_id: string,
): Promise<void> {
  const scripts = await deps.store.teardownBegin(site_id);
  if (scripts.length === 0 && deps.hasFunctionState && !(await deps.hasFunctionState(site_id))) return;
  await deps.kv.delete(fnSiteKey(site_id));
  await dropPrincipalRecord(deps.kv, site_id);
}

export async function teardownSiteFunctions(deps: SweepDeps, site_id: string): Promise<boolean> {
  const scripts = await deps.store.teardownBegin(site_id);
  await deps.kv.delete(fnSiteKey(site_id));
  await dropPrincipalRecord(deps.kv, site_id);
  for (const s of scripts) {
    await deps.wfp().remove(s);
    await deps.store.scriptDeleted(s);
    if (s.startsWith("zft-")) {
      const hex = s.slice(4);
      const testId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      await deps.kv.delete(fnSiteKey(testId));
      await dropPrincipalRecord(deps.kv, testId);
    }
  }
  const done = await deps.store.teardownFinish(site_id);
  if (deps.reconcile) await deps.reconcile(site_id);
  else {
    await deps.kv.delete(fnSiteKey(site_id));
    await dropPrincipalRecord(deps.kv, site_id);
  }
  return done;
}

export async function runSweep(deps: SweepDeps, limit = 200): Promise<Record<string, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((l: Record<string, unknown>) => console.log(JSON.stringify(l)));
  const out = { sites: 0, scripts: 0, failed: 0, logs: 0, runs: 0 };
  const cands = await deps.store.sweepCandidates(now, limit);
  for (const c of cands.filter((x) => x.kind === "site")) {
    try {
      if (await teardownSiteFunctions(deps, c.site_id)) out.sites++;
    } catch (e) {
      out.failed++;
      log({ evt: "site_functions", step: "teardown", outcome: "failed", site_id: c.site_id, error: (e as Error).message.slice(0, 200), alert: "site_function_teardown_failed" });
    }
  }
  for (const c of cands.filter((x) => x.kind === "script" && x.script)) {
    try {
      await deps.wfp().remove(c.script!);
      await deps.store.scriptDeleted(c.script!);
      if (c.script!.startsWith("zft-")) {
        await deps.kv.delete(fnSiteKey(c.site_id));
        await dropPrincipalRecord(deps.kv, c.site_id);
      }
      out.scripts++;
    } catch (e) {
      out.failed++;
      log({ evt: "site_functions", step: "sweep_script", outcome: "failed", script: c.script, error: (e as Error).message.slice(0, 200) });
    }
  }
  const r = await deps.store.retention(now, 5000);
  out.logs = r.logs;
  out.runs = r.runs;
  if (cands.length || r.logs || r.runs) log({ evt: "site_functions", step: "sweep", ...out });
  return out;
}
