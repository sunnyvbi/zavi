
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../../../../../infra/scripts/nginx-enable-http2.sh");

function run(content: string): { code: number; out: string } {
  const file = join(mkdtempSync(join(tmpdir(), "nginx-h2-")), "site");
  writeFileSync(file, content);
  let code = 0;
  try {
    execFileSync("bash", [SCRIPT, file], { stdio: "pipe" });
  } catch (e) {
    code = (e as { status: number }).status;
  }
  return { code, out: readFileSync(file, "utf-8") };
}

const CERTBOT = `server {
    server_name api.zaviagent.com;
    listen 80;
    location / { proxy_pass http://praxis_backend; proxy_http_version 1.1; }
    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/api.zaviagent.com/fullchain.pem; # managed by Certbot
}
`;

describe("nginx-enable-http2.sh", () => {
  it("adds http2 to both TLS listeners and nothing else", () => {
    const { code, out } = run(CERTBOT);
    expect(code).toBe(0);
    expect(out).toContain("listen [::]:443 ssl http2 ipv6only=on; # managed by Certbot");
    expect(out).toContain("listen 443 ssl http2; # managed by Certbot");
    expect(out).toContain("    listen 80;\n");
    expect(out).toContain("proxy_http_version 1.1;");
  });

  it("a second run changes nothing", () => {
    const once = run(CERTBOT).out;
    const twice = run(once);
    expect(twice.code).toBe(3);
    expect(twice.out).toBe(once);
  });

  it("leaves a file with no TLS listener alone", () => {
    const plain = "server {\n    listen 80;\n}\n";
    const { code, out } = run(plain);
    expect(code).toBe(3);
    expect(out).toBe(plain);
  });
});
