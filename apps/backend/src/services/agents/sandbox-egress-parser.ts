
import { parse as shellParse } from "shell-quote";
import { isSecretPath } from "./sandbox-secret-denylist";

export type EgressVerdict = { deny: false } | { deny: true; reason: string };

const ALLOW: EgressVerdict = { deny: false };

const ENV_ECHO = new Proxy(
  {},
  { get: (_t, k) => "$" + String(k) },
) as Record<string, string>;

const SEGMENT_OPS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"]);

const LEADING_SKIP: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "exec",
  "builtin",
  "then",
  "do",
  "else",
  "!",
]);

const READER_CMDS: ReadonlySet<string> = new Set([
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "nl",
  "tac",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "awk",
  "sed",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "base64",
  "cut",
  "jq",
  "yq",
  "tee",
  "cp",
  "mv",
  "dd",
]);

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

function basename(tok: string): string {
  const t = tok.split("/").pop() ?? tok;
  return t.toLowerCase();
}

function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(h) || LOCAL_HOSTS.has(host.toLowerCase())) return true;
  if (h === "github.com" || h.endsWith(".github.com")) return true;
  return false;
}

function hostOfUrl(tok: string): string | null {
  const m = tok.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);
  if (m) {
    return m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  }
  return null;
}

function remoteSpecHost(tok: string): string | null {
  if (/:\/\//.test(tok)) return null;
  const m = tok.match(/^(?:([\w.-]+)@)?([\w.-]+):(?!\/\/)/);
  if (!m) return null;
  const host = m[2];
  if (host.length === 1) return null;
  return host;
}

function inspectSegment(rawTokens: string[]): EgressVerdict {
  let tokens = [...rawTokens];
  while (
    tokens.length > 0 &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) ||
      LEADING_SKIP.has(tokens[0].toLowerCase()))
  ) {
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) return ALLOW;

  const cmd = basename(tokens[0]);
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  const positionals = args.filter((a) => !a.startsWith("-"));

  if (READER_CMDS.has(cmd)) {
    for (const a of args) {
      if (!a.startsWith("-") && isSecretPath(a)) {
        return {
          deny: true,
          reason: `Blocked: \`${cmd}\` would read a secret file (\`${a}\`) into context. Reference the env var name instead of reading the raw secret.`,
        };
      }
    }
  }

  if (cmd === "nc" || cmd === "ncat" || cmd === "netcat" || cmd === "socat") {
    return {
      deny: true,
      reason: `Blocked: \`${cmd}\` (raw network tool) is not permitted in the sandbox — it's an exfiltration/backdoor vector.`,
    };
  }

  if (cmd === "git" && lower.includes("push")) {
    for (const a of args) {
      if (a.startsWith("-")) continue;
      const urlHost = hostOfUrl(a);
      const scpHost = urlHost ? null : remoteSpecHost(a);
      const host = urlHost ?? scpHost;
      if (host && !isAllowedHost(host)) {
        return {
          deny: true,
          reason: `Blocked: \`git push\` to an external host (${host}) that isn't the repo's own host. Push to the repo's origin, or use the PR-proposal flow.`,
        };
      }
    }
  }

  if (cmd === "curl" || cmd === "wget" || cmd === "http" || cmd === "httpie") {
    const flagHeads = lower.map((a) => a.split("=")[0]);
    const uploadFlag =
      flagHeads.some((a) =>
        [
          "-d",
          "--data",
          "--data-binary",
          "--data-raw",
          "--data-ascii",
          "--data-urlencode",
          "-f",
          "--form",
          "-t",
          "--upload-file",
          "--post-data",
          "--post-file",
        ].includes(a),
      ) ||
      lower.some((a, i) => {
        if (a !== "-x" && a !== "--request") return false;
        const v = (lower[i + 1] ?? "").toUpperCase();
        return ["POST", "PUT", "PATCH", "DELETE"].includes(v);
      }) ||
      lower.some((a) =>
        ["--method=post", "--method=put", "--method=patch", "--method=delete"].includes(a),
      );
    if (uploadFlag) {
      for (const a of args) {
        const host = hostOfUrl(a);
        if (host && !isAllowedHost(host)) {
          return {
            deny: true,
            reason: `Blocked: \`${cmd}\` uploads data to an external host (${host}). Outbound data uploads from the sandbox are not permitted.`,
          };
        }
      }
    }
  }

  if (cmd === "scp" || cmd === "rsync" || cmd === "sftp") {
    const dest = positionals.length > 0 ? positionals[positionals.length - 1] : "";
    const host = remoteSpecHost(dest);
    if (host && !isAllowedHost(host)) {
      return {
        deny: true,
        reason: `Blocked: \`${cmd}\` uploads to a remote host (${host}). Outbound file transfer from the sandbox is not permitted.`,
      };
    }
  }

  if (
    ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "npx" || cmd === "bun") &&
      lower.includes("publish")) ||
    (cmd === "cargo" && lower.includes("publish")) ||
    (cmd === "poetry" && lower.includes("publish")) ||
    (cmd === "twine" && lower.includes("upload")) ||
    (cmd === "gem" && lower.includes("push")) ||
    (cmd === "mvn" && lower.some((a) => a === "deploy" || a.endsWith(":deploy")))
  ) {
    return {
      deny: true,
      reason: `Blocked: publishing a package from the sandbox (\`${cmd} ${lower.find((a) => a === "publish" || a === "upload" || a === "push" || a === "deploy") ?? ""}\`) is not permitted — it would push the customer's code to an external registry.`,
    };
  }

  if (cmd === "docker" && (lower.includes("push") || lower.includes("login"))) {
    return {
      deny: true,
      reason: `Blocked: \`docker ${lower.includes("push") ? "push" : "login"}\` from the sandbox is not permitted (image/registry exfil vector).`,
    };
  }

  if (cmd === "aws" && lower.includes("s3")) {
    const dest = positionals.length > 0 ? positionals[positionals.length - 1] : "";
    if (
      (lower.includes("cp") || lower.includes("sync") || lower.includes("mv")) &&
      dest.toLowerCase().startsWith("s3://")
    ) {
      return {
        deny: true,
        reason: `Blocked: \`aws s3\` upload to a bucket (${dest}) is not permitted from the sandbox.`,
      };
    }
  }
  if ((cmd === "gsutil" || cmd === "gcloud") && positionals.length > 0) {
    const dest = positionals[positionals.length - 1];
    if (dest.toLowerCase().startsWith("gs://")) {
      return {
        deny: true,
        reason: `Blocked: upload to a Google Cloud Storage bucket (${dest}) is not permitted from the sandbox.`,
      };
    }
  }

  return ALLOW;
}

function splitSegments(tokens: ReturnType<typeof shellParse>): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (typeof t === "string") {
      cur.push(t);
    } else if (t && typeof t === "object" && "op" in t) {
      const op = (t as { op: string }).op;
      if (SEGMENT_OPS.has(op)) {
        if (cur.length) segs.push(cur);
        cur = [];
      }
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export function inspectShellCommand(command: string): EgressVerdict {
  if (!command || typeof command !== "string") return ALLOW;

  const subs: string[] = [];
  for (const m of command.matchAll(/\$\(([^()]*)\)/g)) subs.push(m[1]);
  for (const m of command.matchAll(/`([^`]*)`/g)) subs.push(m[1]);
  for (const inner of subs) {
    const v = inspectShellCommand(inner);
    if (v.deny) {
      return { deny: true, reason: `In command substitution — ${v.reason}` };
    }
  }

  for (const line of command.split(/[\r\n\u2028\u2029]+/)) {
    if (!line.trim()) continue;
    let tokens: ReturnType<typeof shellParse>;
    try {
      tokens = shellParse(line, ENV_ECHO);
    } catch {
      continue;
    }
    for (const seg of splitSegments(tokens)) {
      const v = inspectSegment(seg);
      if (v.deny) return v;
    }
  }

  return ALLOW;
}
