
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(__dirname, "..", "..", "..", "..", "..");
const wf = readFileSync(join(repo, ".github", "workflows", "deploy.yml"), "utf8");

function job(name: string): string {
  const start = wf.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const next = wf.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return next === -1 ? wf.slice(start) : wf.slice(start, start + 1 + next);
}

describe("deploy.yml: target input", () => {
  it("offers all-in-one (default), api and worker", () => {
    expect(wf).toMatch(/target:\n\s+description:[^\n]*\n\s+required: false\n\s+default: all-in-one\n\s+type: choice\n\s+options:\n\s+- all-in-one\n\s+- api\n\s+- worker/);
    expect(wf).toContain("run-name: deploy ${{ inputs.target || 'all-in-one' }}");
  });

  it("an unset worker host yields an empty SSH_SERVER, never the API host's IP", () => {
    expect(wf).toContain(
      "SSH_SERVER: ${{ inputs.target == 'worker' && vars.WORKER_EC2_HOST || (inputs.target != 'worker' && '184.169.192.250' || '') }}",
    );
    expect(job("check")).toContain('if [ -z "${{ env.SSH_SERVER }}" ]; then');
  });

  it("pins host keys per target at both SSH setup sites", () => {
    const sel = "known_hosts: ${{ inputs.target == 'worker' && vars.WORKER_EC2_KNOWN_HOSTS || env.API_KNOWN_HOSTS }}";
    expect(job("check")).toContain(sel);
    expect(job("build-and-deploy")).toContain(sel);
  });

  it("migrations always tunnel through the API host (prod Postgres allowlists its IP)", () => {
    expect(job("migrate")).toMatch(/env:\n\s+SSH_SERVER: 184\.169\.192\.250/);
  });

  it("dedupe compares per target", () => {
    expect(job("dedupe")).toContain('select(.display_title == \\"deploy ${DEPLOY_TARGET}\\")');
  });
});

describe("deploy.yml: the worker target", () => {
  it("skips the email Worker but ships the site Workers, so site builds never run ahead of the edge", () => {
    expect(job("deploy-worker")).toContain("if: ${{ inputs.target != 'worker' }}");
    expect(job("deploy-site-workers")).toContain(
      "SKIP_SITE_WORKERS: ${{ inputs.skip_site_workers && 'true' || 'false' }}",
    );
    expect(job("build-and-deploy")).toContain("needs: [check, migrate, build-image, deploy-worker, deploy-site-workers]");
  });

  it("picks the compose file by target, before the rollback snapshot and every compose call", () => {
    const b = job("build-and-deploy");
    const pick = b.indexOf('case "${DEPLOY_TARGET:-all-in-one}" in');
    expect(pick).toBeGreaterThan(-1);
    expect(b).toContain("api)    COMPOSE=docker/api/docker-compose.yml;    START_VOICE=1;");
    expect(b).toContain("worker) COMPOSE=docker/worker/docker-compose.yml; START_VOICE=0;");
    expect(b).toContain("*)      COMPOSE=docker/main/docker-compose.yml;   START_VOICE=1;");
    expect(pick).toBeLessThan(b.indexOf("# --- A0. Snapshot"));
    expect(b).not.toMatch(/docker compose -f \.\/docker\/main\/docker-compose\.yml/);
    expect(b).toContain("DEPLOY_TARGET='${{ env.DEPLOY_TARGET }}'");
  });

  it("snapshots the RENDERED compose, so an extends-based file still rolls back", () => {
    expect(job("build-and-deploy")).toContain('docker compose -f "$SNAP" config > "$ROLLBACK_COMPOSE"');
  });

  it("boots the C3 probe in the target's role and never starts voice on the worker", () => {
    const b = job("build-and-deploy");
    expect(b).toContain('PROBE_ROLE="-e PRAXIS_ROLE=worker -e PRAXIS_SECRETS_OVERLAY_ID=zavi-prod-worker"');
    expect(b).toMatch(/-e PRAXIS_CONTAINER_ROLE=probe \\\n\s+\$PROBE_ROLE \\\n\s+praxis-backend:latest/);
    expect(b).toContain('if [ "$START_VOICE" != "1" ]; then');
    expect(b).toContain('[ "$START_VOICE" = "1" ] && ( cd apps/backend && docker compose -f "./$COMPOSE"');
    expect(b).not.toContain("host-role.sh");
  });

  it("once a worker exists, a plain all-in-one deploy refuses instead of flipping the API host back", () => {
    expect(job("check")).toContain(
      'if [ "${{ env.DEPLOY_TARGET }}" = "all-in-one" ] && [ -n "${{ vars.WORKER_EC2_HOST }}" ]; then',
    );
  });

  it("an all-in-one deploy refuses unless the worker host answers nothing (502 or no reply)", () => {
    expect(job("check")).toContain("https://jobs.zaviagent.com/livez");
    expect(job("check")).toContain('if [ "$jobs_live" != "502" ] && [ "$jobs_live" != "000" ]; then');
  });

  it("an api deploy with no worker host refuses, so jobs never lose their only host", () => {
    expect(job("check")).toContain(
      'if [ "${{ env.DEPLOY_TARGET }}" = "api" ] && [ -z "${{ vars.WORKER_EC2_HOST }}" ]; then',
    );
  });

  it("syncs Inngest on the target host, and not at all from a split api host", () => {
    const b = job("build-and-deploy");
    expect(b).toContain('SYNC_URL="https://${{ env.PUBLIC_HOST }}/api/inngest"');
    expect(b).toContain('curl -fsS -m 30 -X PUT "$SYNC_URL"');
    expect(b).not.toContain('"https://api.zaviagent.com/api/inngest"');
    expect(b).toContain('if [ "${{ env.DEPLOY_TARGET }}" = "api" ]; then');
  });

  it("the Inngest sync step goes red when registration did not land, and the verdict says the image is live", () => {
    const deploy = job("build-and-deploy");
    expect(deploy).toContain("grep -q 'Successfully registered'");
    expect(deploy).toContain('echo "failed=1" >> "$GITHUB_OUTPUT"');
    expect(deploy).toContain("inngest_sync_failed: ${{ steps.inngest_sync.outputs.failed }}");
    expect(job("deploy-verdict")).toContain("NEW IMAGE IS LIVE, BUT INNGEST DID NOT REGISTER");
  });
});
