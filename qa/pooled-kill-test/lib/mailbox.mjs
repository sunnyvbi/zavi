import tls from "node:tls";
import { createInterface } from "node:readline";

export function mailboxFromEnv() {
  const kind = process.env.POOLED_QA_MAILBOX || "manual";
  if (kind === "imap") {
    const need = ["POOLED_QA_IMAP_HOST", "POOLED_QA_IMAP_USER", "POOLED_QA_IMAP_PASSWORD"];
    const missing = need.filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`POOLED_QA_MAILBOX=imap needs ${missing.join(", ")} (see RUNBOOK.md)`);
    return imapMailbox({
      host: process.env.POOLED_QA_IMAP_HOST,
      port: Number(process.env.POOLED_QA_IMAP_PORT || 993),
      user: process.env.POOLED_QA_IMAP_USER,
      pass: process.env.POOLED_QA_IMAP_PASSWORD,
    });
  }
  if (kind === "manual") return manualMailbox();
  throw new Error(`unknown POOLED_QA_MAILBOX=${kind}`);
}

export function decodeMail(raw) {
  const b64 = [...raw.matchAll(/Content-Transfer-Encoding:\s*base64[^]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/gi)]
    .map((m) => { try { return Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return ""; } });
  return [raw, ...b64].join("\n")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function findAuthLinks(raw, host) {
  const text = decodeMail(raw);
  const re = new RegExp(`https://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/auth/callback\\?[^\\s"'<>)\\]]+`, "g");
  return [...new Set(text.match(re) ?? [])];
}

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function imapSession({ host, port, user, pass }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host });
    let buf = "";
    let waiter = null;
    let n = 0;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("imap: connect timeout")); }, 20000);
    sock.setEncoding("utf8");
    sock.on("data", (d) => { buf += d; waiter?.(); });
    sock.on("error", (e) => { clearTimeout(timer); reject(new Error(`imap: ${e.message}`)); });
    const until = (pred) => new Promise((res, rej) => {
      const t = setTimeout(() => { waiter = null; rej(new Error("imap: response timeout")); }, 30000);
      waiter = () => { const r = pred(); if (r !== null) { clearTimeout(t); waiter = null; res(r); } };
      waiter();
    });
    const cmd = async (line, { secret = false } = {}) => {
      const tag = `kk${++n}`;
      const start = buf.length;
      sock.write(`${tag} ${line}\r\n`);
      const out = await until(() => {
        const m = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`).exec(buf.slice(start));
        return m ? { status: m[2], text: buf.slice(start, start + m.index + m[0].length) } : null;
      });
      if (out.status !== "OK") throw new Error(`imap: ${secret ? "LOGIN" : line.split(" ")[0]} -> ${out.status}`);
      return out.text;
    };
    sock.once("secureConnect", async () => {
      try {
        await until(() => (/^\* (OK|PREAUTH)/m.test(buf) ? true : null));
        clearTimeout(timer);
        await cmd(`LOGIN ${quote(user)} ${quote(pass)}`, { secret: true });
        await cmd("SELECT INBOX");
        resolve({ cmd, close: () => { try { sock.write(`kz LOGOUT\r\n`); } catch {  } sock.end(); } });
      } catch (e) { sock.destroy(); reject(e); }
    });
  });
}

function imapMailbox(cfg) {
  const searchUids = async (s, to) => {
    const out = await s.cmd(`UID SEARCH TO ${quote(to)}`);
    const line = out.split("\r\n").find((l) => l.startsWith("* SEARCH")) ?? "* SEARCH";
    return line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
  };
  return {
    kind: "imap",
    async mark(to) {
      const s = await imapSession(cfg);
      try { const u = await searchUids(s, to); return u.length ? u[u.length - 1] : 0; } finally { s.close(); }
    },
    async waitForLink({ to, host, after = 0, timeoutMs = 180000 }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = await imapSession(cfg);
        try {
          const uids = (await searchUids(s, to)).filter((u) => u > after).reverse();
          for (const uid of uids) {
            const raw = await s.cmd(`UID FETCH ${uid} BODY.PEEK[]`);
            const links = findAuthLinks(raw, host);
            if (links.length) return links[links.length - 1];
          }
        } finally { s.close(); }
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error(`no auth mail for ${to} within ${Math.round(timeoutMs / 1000)}s`);
    },
  };
}

function manualMailbox() {
  return {
    kind: "manual",
    async mark() { return 0; },
    async waitForLink({ to, host }) {
      process.stderr.write(`\n>>> Open the newest auth mail sent to ${to} and paste its https://${host}/api/auth/callback?... link (do not click it):\n`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const line = await new Promise((res) => rl.once("line", res));
      rl.close();
      const links = findAuthLinks(line.trim(), host);
      if (!links.length) throw new Error(`that is not a https://${host}/api/auth/callback link`);
      return links[0];
    },
  };
}
