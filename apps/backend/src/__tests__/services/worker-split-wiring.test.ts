
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..");
const app = readFileSync(join(root, "src", "app.ts"), "utf8");
const server = readFileSync(join(root, "server.ts"), "utf8");

describe("app.ts: the api host serves no Inngest functions", () => {
  it("mounts /api/inngest only inside the servesInngest(processRole()) gate", () => {
    const gate = app.indexOf("if (servesInngest(processRole())) {");
    const mount = app.indexOf('"/api/inngest",');
    expect(gate).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(gate);
    const close = app.indexOf("\n  }\n", mount);
    expect(app.indexOf("serveInngest(", mount)).toBeLessThan(close);
    expect(app.split('"/api/inngest"').length - 1).toBe(1);
  });
});

describe("server.ts: boot side effects follow bootPlan()", () => {
  it("reads the plan before starting anything", () => {
    const main = server.slice(server.indexOf("async function main()"));
    expect(main.indexOf("const plan = bootPlan();")).toBeGreaterThan(-1);
    expect(main.indexOf("const plan = bootPlan();")).toBeLessThan(main.indexOf("startOAuthTokenPoolRefresh()"));
  });

  it("gates boot-reap, self-sync, Discord and worker secrets on the plan", () => {
    expect(server).toContain("if (plan.bootReap) {");
    expect(server).toContain("if (plan.inngestSelfSync) {");
    expect(server).toContain("if (plan.discordGateway) {");
    expect(server).toContain("if (plan.platformWorkerSecrets) {");
    expect(server).not.toMatch(/if \(isCanonicalContainer\(\)\)/);
    expect(server).not.toMatch(/if \(shouldRunBootReap\(\)\)/);
  });

  it("the split worker reaps only its own runs", () => {
    expect(server).toContain("...(plan.bootReapOwnRunsOnly ? { ownRunsOnly: true } : {})");
  });
});

describe("docker-compose: one file per host, role and secrets from the file + AWS", () => {
  const read = (d: string) => readFileSync(join(root, "docker", d, "docker-compose.yml"), "utf8");
  const main = read("main");
  const api = read("api");
  const worker = read("worker");

  it("today's single host (docker/main) is untouched: no role, no overlay, no host file", () => {
    expect(main).not.toContain("PRAXIS_ROLE");
    expect(main).not.toContain("PRAXIS_SECRETS_OVERLAY_ID");
    expect(main).not.toContain("/etc/praxis");
    expect(main).toContain("mem_limit: 3g");
  });

  it("api and worker extend main, so a change to main reaches both", () => {
    for (const f of [api, worker]) {
      expect(f).toMatch(/extends:\n\s+file: \.\.\/main\/docker-compose\.yml\n\s+service: praxis-backend/);
      expect(f).toContain("name: main");
      expect(f).not.toContain("/etc/praxis");
    }
  });

  it("the api host sets PRAXIS_ROLE=api, keeps praxis-envprod-1 alone and keeps voice", () => {
    expect(api).toContain("- PRAXIS_ROLE=api");
    expect(api).not.toContain("PRAXIS_SECRETS_OVERLAY_ID");
    expect(api).toContain("praxis-voice-pipeline:");
  });

  it("the worker sets PRAXIS_ROLE=worker, layers zavi-prod-worker and has no voice", () => {
    expect(worker).toContain("- PRAXIS_ROLE=worker");
    expect(worker).toContain("- PRAXIS_SECRETS_OVERLAY_ID=zavi-prod-worker");
    expect(worker).not.toContain("praxis-voice-pipeline:");
  });

  it("the worker gets the 8 GB host's limits; the api host keeps main's (4 GB box)", () => {
    expect(worker).toContain("mem_limit: 6g");
    expect(worker).toContain("memory: 6144m");
    const apiConfig = api.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(apiConfig).not.toMatch(/mem_limit|memswap_limit|memory:|cpus:/);
  });
});

describe("nginx jobs.zaviagent.com: only Inngest and health are public", () => {
  const conf = readFileSync(join(root, "..", "..", "infra", "nginx", "jobs.zaviagent.com.conf"), "utf8");
  const api = readFileSync(join(root, "..", "..", "infra", "nginx", "api.zaviagent.com.conf"), "utf8");

  it("proxies /api/inngest with the same 900s streaming budget as the API host", () => {
    const loc = conf.slice(conf.indexOf("location /api/inngest {"));
    expect(loc.slice(0, loc.indexOf("}"))).toContain("proxy_read_timeout 900s;");
    expect(api).toContain("proxy_read_timeout 900s;");
    expect(conf).toContain("proxy_buffering off;");
  });

  it("uses the named upstream and carries the forwarded-header marker deploy.yml checks for", () => {
    expect(conf).not.toContain("127.0.0.1:4000");
    expect(conf).toContain("proxy_pass http://praxis_backend;");
    expect(conf).toContain("nginx drops EVERY inherited");
  });

  it("everything else is 404", () => {
    expect(conf).toMatch(/location \/ \{\s+return 404;\s+\}/);
  });
});
