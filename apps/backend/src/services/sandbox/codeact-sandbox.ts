
import {
  createSandbox,
  destroySandbox,
  execCommand,
  wipeEnv,
  writeFile,
  type ExecResult,
} from "./e2b-client";

export const CODEACT_INPUT_PATH = "/home/user/codeact_input.json";
export const CODEACT_USER_CODE_PATH = "/home/user/codeact_user_code.py";
export const CODEACT_RUNNER_PATH = "/home/user/codeact_runner.py";
export const CODEACT_OUTPUT_PATH = "/home/user/codeact_output.json";

export const FIXED_RUNNER_CMD =
  `python3 -I ${CODEACT_RUNNER_PATH} ${CODEACT_USER_CODE_PATH} ${CODEACT_INPUT_PATH} ${CODEACT_OUTPUT_PATH}`;

export const PYTHON_IMPORT_DENYLIST = [
  "os",
  "sys",
  "subprocess",
  "socket",
  "requests",
  "urllib",
  "urllib2",
  "urllib3",
  "http",
  "httplib",
  "httpx",
  "ftplib",
  "smtplib",
  "telnetlib",
  "asyncio",
  "ctypes",
  "multiprocessing",
  "importlib",
  "pickle",
  "shutil",
  "pathlib",
  "platform",
  "signal",
  "resource",
  "pty",
  "fcntl",
  "mmap",
];

export function buildCodeActRunner(denylist: readonly string[] = PYTHON_IMPORT_DENYLIST): string {
  const denySet = denylist.map((m) => JSON.stringify(m)).join(", ");
  return [
    "import json as _json",
    "import builtins as _b",
    "import sys as _sys",
    "",
    `_DENY = {${denySet}}`,
    "",
    "class _DenyFinder:",
    "    def find_module(self, name, path=None):",
    "        top = name.split('.')[0]",
    "        if top in _DENY:",
    "            return self",
    "        return None",
    "    def load_module(self, name):",
    "        raise ImportError('codeact: import of %r is blocked by the CodeAct denylist' % name)",
    "    # PEP 451 hook (py3.4+): block at the finder stage too.",
    "    def find_spec(self, name, path=None, target=None):",
    "        top = name.split('.')[0]",
    "        if top in _DENY:",
    "            raise ImportError('codeact: import of %r is blocked by the CodeAct denylist' % name)",
    "        return None",
    "",
    "_sys.meta_path.insert(0, _DenyFinder())",
    "",
    "# Read fixed paths from argv (set by the FIXED runner command, not the model).",
    "_user_code_path = _sys.argv[1]",
    "_input_path = _sys.argv[2]",
    "_output_path = _sys.argv[3]",
    "",
    "with open(_input_path, 'r') as _f:",
    "    _input = _json.load(_f)",
    "with open(_user_code_path, 'r') as _f:",
    "    _user_src = _f.read()",
    "",
    "# Restricted builtins: drop the eval/exec/import/file/network escape hatches.",
    "# json stays available to the user via the injected `json` name below.",
    "_DROP = ('eval', 'exec', 'compile', '__import__', 'open', 'input',",
    "         'memoryview', 'breakpoint', 'help', 'vars', 'globals', 'locals')",
    "_safe_builtins = {}",
    "for _k in dir(_b):",
    "    if _k in _DROP:",
    "        continue",
    "    _safe_builtins[_k] = getattr(_b, _k)",
    "",
    "_ns = {",
    "    '__builtins__': _safe_builtins,",
    "    'json': _json,",
    "    'rows': _input.get('rows', _input),",
    "    'data': _input.get('rows', _input),",
    "    'reads': _input.get('reads', []),",
    "    'result': None,",
    "}",
    "",
    "try:",
    "    exec(_user_src, _ns, _ns)",
    "    _result = _ns.get('result', None)",
    "    _payload = {'ok': True, 'result': _result}",
    "except Exception as _e:",
    "    _payload = {'ok': False, 'error': type(_e).__name__, 'message': str(_e)[:2000]}",
    "",
    "with open(_output_path, 'w') as _f:",
    "    _json.dump(_payload, _f, default=str)",
    "print('CODEACT_DONE')",
    "",
  ].join("\n");
}

export type CodeActPythonResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  message?: string;
  stdout?: string;
  stderr?: string;
};

export type RunCodeActPythonArgs = {
  tenant_id: string;
  input: { rows: unknown; reads?: unknown };
  python_code: string;
  max_output_bytes?: number;
  timeout_ms?: number;
};

const DEFAULT_OUTPUT_CAP = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export async function runCodeActPython(args: RunCodeActPythonArgs): Promise<CodeActPythonResult> {
  const outputCap = args.max_output_bytes ?? DEFAULT_OUTPUT_CAP;
  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const sandboxId = await createSandbox({
    tenant_id: args.tenant_id,
    repo_full_name: "codeact/compute",
    allow_internet_access: false,
  });

  try {
    await wipeEnv(sandboxId);

    await writeFile(sandboxId, CODEACT_INPUT_PATH, JSON.stringify(args.input));
    await writeFile(sandboxId, CODEACT_USER_CODE_PATH, args.python_code);
    await writeFile(sandboxId, CODEACT_RUNNER_PATH, buildCodeActRunner());

    const exec: ExecResult = await execCommand(sandboxId, FIXED_RUNNER_CMD, timeoutMs);

    let parsed: CodeActPythonResult;
    try {
      const raw = await readCappedOutput(sandboxId, outputCap);
      parsed = JSON.parse(raw) as CodeActPythonResult;
    } catch (e) {
      parsed = {
        ok: false,
        error: "codeact_no_output",
        message: `Runner produced no parseable output: ${(e as Error).message}`,
      };
    }
    parsed.stdout = exec.stdout?.slice(0, 4000);
    parsed.stderr = exec.stderr?.slice(0, 4000);
    return parsed;
  } finally {
    await destroySandbox(sandboxId).catch((e) => {
      console.error(`[codeact] destroySandbox failed for ${sandboxId}`, e);
    });
  }
}

async function readCappedOutput(sandboxId: string, cap: number): Promise<string> {
  const r = await execCommand(
    sandboxId,
    `head -c ${cap} ${CODEACT_OUTPUT_PATH}`,
    10_000,
  );
  if (r.exit_code !== 0) {
    throw new Error(`output read exit=${r.exit_code} stderr=${r.stderr.slice(0, 400)}`);
  }
  return r.stdout;
}
