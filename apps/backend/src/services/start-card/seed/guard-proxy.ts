
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";

export type GuardProxy = { port: number; close: () => Promise<void>; blocked: () => number };

const ALLOWED_PORTS = new Set([80, 443]);

export type ResolveFn = (host: string) => Promise<string[]>;

const defaultResolve: ResolveFn = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function safeAddress(host: string, resolve: ResolveFn = defaultResolve): Promise<string | null> {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  let addrs: string[];
  if (net.isIP(h)) addrs = [h];
  else {
    try {
      addrs = await resolve(h);
    } catch {
      return null;
    }
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a))) return null;
  return addrs[0];
}

export async function startGuardProxy(opts: { resolve?: ResolveFn } = {}): Promise<GuardProxy> {
  const resolve = opts.resolve ?? defaultResolve;
  let blocked = 0;
  const refuse = (res: http.ServerResponse) => {
    blocked++;
    res.writeHead(403, { "content-type": "text/plain" }).end("blocked by seed-scan guard");
  };

  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      return refuse(res);
    }
    const port = Number(target.port || 80);
    if (target.protocol !== "http:" || !ALLOWED_PORTS.has(port)) return refuse(res);
    const ip = await safeAddress(target.hostname, resolve);
    if (!ip) return refuse(res);
    const upstream = http.request(
      { host: ip, port, method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  server.on("connect", async (req, client: net.Socket, head) => {
    const [host, portStr] = (req.url ?? "").split(/:(?=\d+$)/);
    const port = Number(portStr);
    const ip = ALLOWED_PORTS.has(port) ? await safeAddress(host ?? "", resolve) : null;
    if (!ip) {
      blocked++;
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, ip, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const done = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", done);
    client.on("error", done);
  });

  server.on("upgrade", (_req, socket: net.Socket) => {
    blocked++;
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    blocked: () => blocked,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
