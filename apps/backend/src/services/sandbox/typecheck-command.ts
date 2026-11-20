
import { execCommand } from "@/services/sandbox/e2b-client";

export const RUN_TYPECHECK_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_ERRORS = 30;
const MAX_ERROR_LINE = 300;

export type TypecheckRunStatus = "passed" | "failed" | "couldnt_run";

export type TypecheckRunResult = {
  status: TypecheckRunStatus;
  command?: string;
  exit_code: number | null;
  error_count: number;
  errors: string[];
  truncated: boolean;
  reason?: string;
  ms?: number;
};

export type PackageProbe = {
  script: string | null;
  tsconfig: boolean;
  tsc: boolean;
};

export type TypecheckProbe = {
  root: PackageProbe;
  changed_ts: number;
  pkgs: Array<PackageProbe & { dir: string; count: number }>;
};

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const PROBE_JS = [
  `const fs=require("fs"),path=require("path"),cp=require("child_process");`,
  `let out="";try{out=cp.execSync("git status --porcelain=v1 --untracked-files=all -z",{encoding:"utf8",maxBuffer:64*1024*1024})}catch(e){}`,
  `const parts=out.split("\\0");const files=[];`,
  `for(let i=0;i<parts.length;i++){const p=parts[i];if(p.length<4)continue;files.push(p.slice(3));if(/[RC]/.test(p.slice(0,2)))i++;}`,
  `const ts=files.filter(f=>/\\.(ts|tsx|mts|cts)$/.test(f)&&!/(^|\\/)node_modules\\//.test(f));`,
  `const info=d=>{const b=d||".";let s=null;try{const sc=JSON.parse(fs.readFileSync(path.join(b,"package.json"),"utf8")).scripts||{};s=sc.typecheck?"typecheck":(sc["type-check"]?"type-check":null)}catch(e){}return{script:s,tsconfig:fs.existsSync(path.join(b,"tsconfig.json")),tsc:fs.existsSync(path.join(b,"node_modules/.bin/tsc"))}};`,
  `const counts={};for(const f of ts){let d=path.dirname(f);while(d!=="."&&d!=="/"&&!fs.existsSync(path.join(d,"package.json")))d=path.dirname(d);const k=(d==="."||d==="/")?"":d;counts[k]=(counts[k]||0)+1;}`,
  `const pkgs=Object.keys(counts).map(d=>Object.assign({dir:d,count:counts[d]},info(d)));`,
  `console.log("__TCPROBE__"+JSON.stringify({root:info(""),changed_ts:ts.length,pkgs:pkgs}));`,
].join("");

export function buildTypecheckProbeCommand(root: string): string {
  return `cd ${shq(root)} && node -e '${PROBE_JS}'`;
}

export function parseTypecheckProbe(stdout: string): TypecheckProbe | null {
  const m = (stdout || "").match(/__TCPROBE__(\{.*\})/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]) as TypecheckProbe;
    if (!j || typeof j !== "object" || !j.root || !Array.isArray(j.pkgs)) return null;
    return j;
  } catch {
    return null;
  }
}

export function selectTypecheckCommand(
  probe: TypecheckProbe,
): { command: string; unchecked: string[] } | { command: null; reason: string } {
  const targets =
    probe.pkgs.length > 0
      ? [...probe.pkgs].sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
      : [{ dir: "", count: 0, ...probe.root }];
  const cmds: string[] = [];
  const unchecked: string[] = [];
  for (const t of targets) {
    if (t.script) {
      const run = `npm run ${t.script} --silent`;
      cmds.push(t.dir ? `(cd ${shq(t.dir)} && ${run})` : run);
      continue;
    }
    const tsc = t.dir && t.tsc ? `${t.dir}/node_modules/.bin/tsc` : probe.root.tsc ? "node_modules/.bin/tsc" : null;
    const tsconfig = t.dir && t.tsconfig ? `${t.dir}/tsconfig.json` : probe.root.tsconfig ? "tsconfig.json" : null;
    if (tsc && tsconfig) cmds.push(`${shq(tsc)} --noEmit -p ${shq(tsconfig)}`);
    else unchecked.push(t.dir || ".");
  }
  const unique = [...new Set(cmds)];
  if (unique.length === 0) {
    const anyTsconfig = probe.root.tsconfig || probe.pkgs.some((p) => p.tsconfig);
    return {
      command: null,
      reason: anyTsconfig
        ? "no typecheck script and no installed tsc (node_modules/.bin/tsc)"
        : "no typecheck script and no tsconfig.json",
    };
  }
  return { command: unique.join(" && "), unchecked };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const PLAIN_ERR = /^(\S[^\n]*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PRETTY_ERR = /^(\S[^\n]*?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const NOT_RUN =
  /npm (?:ERR!|error) Missing script:|command not found|No such file or directory|JavaScript heap out of memory|npx canceled due to missing packages/i;

export function parseTypecheckRun(
  command: string,
  r: { stdout: string; stderr: string; exit_code: number; timed_out?: boolean; ms?: number },
): TypecheckRunResult {
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(ANSI, "");
  const all: string[] = [];
  let lineCut = false;
  let found = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const f = line.match(/^Found (\d+) errors?\b/);
    if (f) found += Number(f[1]);
    const m = line.match(PLAIN_ERR) ?? line.match(PRETTY_ERR);
    if (!m) continue;
    let norm = `${m[1]}(${m[2]},${m[3]}): error ${m[4]}: ${m[5]}`;
    if (norm.length > MAX_ERROR_LINE) {
      norm = `${norm.slice(0, MAX_ERROR_LINE)}...`;
      lineCut = true;
    }
    all.push(norm);
  }
  const error_count = Math.max(all.length, found);
  const errors = all.slice(0, MAX_ERRORS);
  const truncated = lineCut || error_count > errors.length;
  const base = { command, exit_code: r.exit_code, ms: r.ms };
  if (error_count > 0) {
    return { ...base, status: "failed", error_count, errors, truncated };
  }
  if (r.timed_out) {
    return { ...base, exit_code: null, status: "couldnt_run", error_count: 0, errors: [], truncated: false, reason: "timed out" };
  }
  if (r.exit_code === 0) {
    return { ...base, status: "passed", error_count: 0, errors: [], truncated: false };
  }
  if (r.exit_code === 127 || NOT_RUN.test(text)) {
    return { ...base, status: "couldnt_run", error_count: 0, errors: [], truncated: false, reason: "the typecheck command could not start" };
  }
  const tail = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-5)
    .map((l) => (l.length > MAX_ERROR_LINE ? `${l.slice(0, MAX_ERROR_LINE)}...` : l));
  return { ...base, status: "failed", error_count: 0, errors: tail, truncated: false };
}

type Exec = typeof execCommand;

export async function runTypecheckInSandbox(opts: {
  sandbox_id: string;
  root: string;
  exec?: Exec;
}): Promise<TypecheckRunResult> {
  const exec = opts.exec ?? execCommand;
  const couldnt = (reason: string, command?: string): TypecheckRunResult => ({
    status: "couldnt_run",
    ...(command ? { command } : {}),
    exit_code: null,
    error_count: 0,
    errors: [],
    truncated: false,
    reason,
  });
  let probe: TypecheckProbe | null = null;
  try {
    const p = await exec(opts.sandbox_id, buildTypecheckProbeCommand(opts.root), PROBE_TIMEOUT_MS);
    probe = parseTypecheckProbe(p.stdout);
  } catch {
    probe = null;
  }
  if (!probe) return couldnt("could not inspect the repo (is node installed?)");
  const pick = selectTypecheckCommand(probe);
  if (pick.command === null) return couldnt(pick.reason);
  try {
    const r = await exec(
      opts.sandbox_id,
      `export npm_config_yes=false; cd ${shq(opts.root)} && ${pick.command}`,
      RUN_TYPECHECK_TIMEOUT_MS,
    );
    const out = parseTypecheckRun(pick.command, r);
    if (out.status === "passed" && pick.unchecked.length > 0) {
      return {
        ...out,
        status: "couldnt_run",
        reason: `no typecheck command for ${pick.unchecked.join(", ")}`,
      };
    }
    return out;
  } catch (e) {
    return couldnt(`sandbox error: ${(e as Error).message}`.slice(0, 200), pick.command);
  }
}
