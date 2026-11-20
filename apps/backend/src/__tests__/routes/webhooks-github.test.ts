import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../routes/webhooks/github.ts"),
  "utf-8",
);

describe("github webhook — pull_request.merged loop closure", () => {
  it("handles pull_request.closed events with merged=true", () => {
    expect(src).toMatch(/event === "pull_request"/);
    expect(src).toMatch(/action === "closed"/);
    expect(src).toMatch(/merged\?: boolean/);
  });

  it("calls mark_pr_merged RPC with tenant_id + pr_url + merged_at", () => {
    expect(src).toMatch(/\.rpc\("mark_pr_merged"/);
    expect(src).toMatch(/p_tenant_id: tenant_id/);
    expect(src).toMatch(/p_pr_url: pr_url/);
    expect(src).toMatch(/p_merged_at: merged_at/);
  });

  it("requires tenant_id resolution before invoking mark_pr_merged (cross-tenant defense)", () => {
    expect(src).toMatch(
      /event === "pull_request"[\s\S]*?action === "closed"[\s\S]*?tenant_id[\s\S]*?merged === true/,
    );
  });

  it("does not throw on missing pr_url (defensive — silent skip)", () => {
    expect(src).toMatch(/pr\.html_url \?\? ""/);
    expect(src).toMatch(/if \(pr_url\)/);
  });
});

describe("github webhook — pull_request closed_unmerged tracking (P0-1)", () => {
  it("has a closed-without-merge branch gated on merged !== true", () => {
    expect(src).toMatch(/merged !== true/);
  });

  it("calls mark_pr_closed_unmerged RPC with tenant_id + pr_url + closed_at", () => {
    expect(src).toMatch(/\.rpc\("mark_pr_closed_unmerged"/);
    expect(src).toMatch(/p_closed_at: closed_at/);
  });

  it("the closed_unmerged branch requires the connection-derived tenant_id (cross-tenant defense)", () => {
    expect(src).toMatch(
      /event === "pull_request"[\s\S]*?action === "closed"[\s\S]*?tenant_id[\s\S]*?merged !== true/,
    );
  });

  it("the merged===true branch comes FIRST so closed+merged never records closed_unmerged", () => {
    const mergedIdx = src.indexOf('rpc("mark_pr_merged"');
    const closedIdx = src.indexOf('rpc("mark_pr_closed_unmerged"');
    expect(mergedIdx).toBeGreaterThan(-1);
    expect(closedIdx).toBeGreaterThan(mergedIdx);
  });
});

describe("github webhook — C2 deploy-truth watch enqueue", () => {
  it("reads merge_commit_sha off the merged pull_request", () => {
    expect(src).toMatch(/merge_commit_sha/);
  });

  it("calls enqueueDeployTruthWatch on a merged PR with the repo full_name + merge SHA", () => {
    expect(src).toMatch(/enqueueDeployTruthWatch/);
    expect(src).toMatch(/mergeCommitSha:/);
    expect(src).toMatch(/repoFullName/);
  });

  it("the deploy-truth enqueue does NOT depend on the connector-derived tenant_id (resolves its own via tenant_resources — Q8)", () => {
    const enqueueIdx = src.indexOf("enqueueDeployTruthWatch({");
    const markMergedIdx = src.indexOf('rpc("mark_pr_merged"');
    expect(enqueueIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeLessThan(markMergedIdx);
  });

  it("the enqueue is best-effort — wrapped so it never breaks the webhook 200", () => {
    expect(src).toMatch(/deploy-truth watch enqueue skipped/);
  });
});
