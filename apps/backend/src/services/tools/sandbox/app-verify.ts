
import { z } from "zod";

export const APP_VERIFY_BOOT_TIMEOUT_DEFAULT_S = 60;
export const APP_VERIFY_BOOT_TIMEOUT_MAX_S = 180;
export const APP_VERIFY_OUTPUT_TAIL_BYTES = 4096;
export const APP_VERIFY_EXEC_HEADROOM_S = 30;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export const appVerifyInputSchema = z.object({
  request_path: z.string().min(1),
  expected_status: z.number().int().min(100).max(599).default(200),
  expect_body_contains: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("127.0.0.1"),
  start_cmd: z.string().optional(),
  health_path: z.string().optional(),
  boot_timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(APP_VERIFY_BOOT_TIMEOUT_MAX_S)
    .default(APP_VERIFY_BOOT_TIMEOUT_DEFAULT_S),
});

export type AppVerifyInput = z.infer<typeof appVerifyInputSchema>;

export type AppVerifyResult = {
  ok: boolean;
  reason?: string;
  status?: number | null;
  booted?: boolean;
  body_matched?: boolean;
  output_tail?: string;
};

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim());
}

export function isSafeRequestPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (/[\r\n]/.test(p)) return false;
  if (/\s/.test(p)) return false;
  if (p.includes("://")) return false;
  return true;
}

function shq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export function buildAppVerifyScript(input: AppVerifyInput): string {
  const host = input.host;
  const port = input.port;
  const healthPath = input.health_path ?? input.request_path;
  const bootTimeout = input.boot_timeout_seconds;
  const base = `http://${host}:${port}`;
  const detect = input.start_cmd
    ? `START_CMD=${shq(input.start_cmd)}`
    : [
        `START_CMD=""`,
        `if [ -f package.json ]; then`,
        `  for s in dev start server; do`,
        `    if node -e "process.exit(require('./package.json').scripts&&require('./package.json').scripts['$s']?0:1)" 2>/dev/null; then`,
        `      START_CMD="npm run $s"; break;`,
        `    fi`,
        `  done`,
        `fi`,
        `[ -z "$START_CMD" ] && START_CMD="npm run dev"`,
      ].join("\n");

  return [
    `set +e`,
    detect,
    `LOG="$(mktemp)"`,
    `setsid bash -c "$START_CMD" > "$LOG" 2>&1 &`,
    `APP_PGID=$!`,
    `READY=0`,
    `for i in $(seq 1 ${bootTimeout}); do`,
    `  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 ${shq(`${base}${healthPath}`)} 2>/dev/null)`,
    `  case "$CODE" in 2*|3*) READY=1; break;; esac`,
    `  sleep 1`,
    `done`,
    `STATUS=""`,
    `BODY=""`,
    `if [ "$READY" = "1" ]; then`,
    `  STATUS=$(curl -s -o /tmp/app_verify_body -w '%{http_code}' --max-time 5 ${shq(`${base}${input.request_path}`)} 2>/dev/null)`,
    `  BODY=$(head -c ${APP_VERIFY_OUTPUT_TAIL_BYTES} /tmp/app_verify_body 2>/dev/null)`,
    `fi`,
    `kill -TERM -"$APP_PGID" 2>/dev/null; sleep 1; kill -KILL -"$APP_PGID" 2>/dev/null`,
    `BODY_B64=$(printf '%s' "$BODY" | base64 | tr -d '\\n')`,
    `printf '__APP_VERIFY__{"booted":%s,"status":"%s","body_b64":"%s"}\\n' "$READY" "$STATUS" "$BODY_B64"`,
    `echo '----- app log tail -----'`,
    `tail -c ${APP_VERIFY_OUTPUT_TAIL_BYTES} "$LOG" 2>/dev/null`,
  ].join("\n");
}

export function parseAppVerifyOutput(
  stdout: string,
  input: AppVerifyInput,
): AppVerifyResult {
  const tail = stdout.slice(-APP_VERIFY_OUTPUT_TAIL_BYTES);
  const m = stdout.match(/__APP_VERIFY__(\{.*?\})\s*$/m);
  if (!m) {
    return {
      ok: false,
      reason: "no_sentinel",
      status: null,
      booted: false,
      output_tail: tail,
    };
  }
  let sentinel: { booted?: number | boolean; status?: string; body_b64?: string };
  try {
    sentinel = JSON.parse(m[1]);
  } catch {
    return { ok: false, reason: "sentinel_parse_failed", status: null, booted: false, output_tail: tail };
  }
  const booted = sentinel.booted === 1 || sentinel.booted === true;
  if (!booted) {
    return {
      ok: false,
      reason: "boot_timeout",
      status: null,
      booted: false,
      output_tail: tail,
    };
  }
  const status = sentinel.status ? Number(sentinel.status) : null;
  let body = "";
  if (sentinel.body_b64) {
    try {
      body = Buffer.from(sentinel.body_b64, "base64").toString("utf8");
    } catch {
      body = "";
    }
  }
  const statusOk = status === input.expected_status;
  let body_matched: boolean | undefined;
  if (input.expect_body_contains !== undefined) {
    body_matched = body.includes(input.expect_body_contains);
  }
  const ok = statusOk && (body_matched === undefined ? true : body_matched);
  return {
    ok,
    reason: ok
      ? undefined
      : !statusOk
        ? `status_mismatch_expected_${input.expected_status}_got_${status ?? "none"}`
        : "body_assertion_failed",
    status,
    booted: true,
    body_matched,
    output_tail: tail,
  };
}

export function validateAppVerifyInput(input: AppVerifyInput): string | null {
  if (!isLoopbackHost(input.host)) {
    return `host must be loopback (localhost/127.0.0.1/::1); got "${input.host}"`;
  }
  if (!isSafeRequestPath(input.request_path)) {
    return `request_path must be a root-relative path with no host/scheme/whitespace; got "${input.request_path}"`;
  }
  if (input.health_path !== undefined && !isSafeRequestPath(input.health_path)) {
    return `health_path must be a root-relative path; got "${input.health_path}"`;
  }
  return null;
}
