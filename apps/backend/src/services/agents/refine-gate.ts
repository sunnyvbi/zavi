
import { serviceClient } from "@/services/supabase";
import { callMcpTool } from "@/services/mcp/execute";
import { logEvent } from "@/services/logging/logEvent";
import { probeBranchPreviewForRun } from "@/services/pipeline/preview-probe";
import {
  findProtectedPathHits,
  coerceProtectedPathHits,
  describeProtectedHits,
  DEFAULT_PROTECTED_GLOBS,
  PROTECTED_PATH_HOLD_REASON,
  type ProtectedPathHit,
} from "@/services/agents/pipeline-policy";

export type GateVerdict = "pass" | "fail";
export type PreviewVerdict = "pass" | "fail" | "skipped";

export type RefineGateMeta = {
  head_branch: string;
  commit_sha: string;
  base_branch: string;
  repo: string;
  title: string;
  build_ok: boolean;
  tests_passed: number;
  tests_failed: number;
  typecheck_ok: boolean | null;
};

export type GateEvidence = {
  build_ok: boolean;
  tests: { passed: number; failed: number };
  typecheck_ok: boolean | null;
  preview_smoke: { verdict: PreviewVerdict; evidence_md: string };
  gate_verdict: GateVerdict;
  protected_paths?: ProtectedPathHit[];
};

export const GATE_LABEL_PASS = "zavi:review-ready";
export const GATE_LABEL_FAIL = "zavi:gate-failed";

export function parsePreviewSmokeVerdict(qaOutput: string | null | undefined): {
  verdict: PreviewVerdict;
  evidence_md: string;
} {
  if (typeof qaOutput !== "string" || qaOutput.trim().length === 0) {
    return { verdict: "skipped", evidence_md: "" };
  }
  const m = qaOutput.match(/<preview_smoke>([\s\S]*?)<\/preview_smoke>/i);
  if (!m) return { verdict: "skipped", evidence_md: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return { verdict: "skipped", evidence_md: "" };
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const raw = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  const verdict: PreviewVerdict =
    raw === "pass" ? "pass" : raw === "fail" ? "fail" : "skipped";
  const evidence_md =
    typeof obj.evidence_md === "string" ? obj.evidence_md.slice(0, 4000) : "";
  return { verdict, evidence_md };
}

export function computeGateVerdict(
  mechanical: { build_ok: boolean; tests_failed: number },
  preview: { verdict: PreviewVerdict },
): GateVerdict {
  const mechanicalPass = mechanical.build_ok === true && mechanical.tests_failed === 0;
  const previewPass = preview.verdict !== "fail";
  return mechanicalPass && previewPass ? "pass" : "fail";
}

export function gateLabel(verdict: GateVerdict): string {
  return verdict === "pass" ? GATE_LABEL_PASS : GATE_LABEL_FAIL;
}

export function renderGateEvidenceMarkdown(evidence: GateEvidence): string {
  const { build_ok, tests, typecheck_ok, preview_smoke, gate_verdict } = evidence;
  const check = (ok: boolean) => (ok ? "✅" : "❌");
  const lines: string[] = [];
  lines.push("## Zavi gate evidence");
  lines.push("");
  const protectedHits = evidence.protected_paths ?? [];
  lines.push(
    gate_verdict === "pass"
      ? "**Verdict: PASS — review-ready.** Gates ran before this PR opened."
      : protectedHits.length > 0
        ? "**Verdict: FAIL — human review required (protected path).** This change touches a protected path (env / secrets / migrations / auth / billing / webhooks / middleware). It ALWAYS needs a human, regardless of build/test/preview results — the change is parked here for inspection."
        : "**Verdict: FAIL — do NOT merge.** Gates found issues; the change is parked here for inspection.",
  );
  lines.push("");
  if (protectedHits.length > 0) {
    lines.push(`_Protected paths touched:_ ${describeProtectedHits(protectedHits)}`);
    lines.push("");
  }
  lines.push("| Gate | Result |");
  lines.push("| --- | --- |");
  lines.push(`| Build (typecheck) | ${check(build_ok)} ${build_ok ? "ok" : "broken"} |`);
  lines.push(
    `| Tests | ${check(tests.failed === 0)} ${tests.passed} passed, ${tests.failed} failed |`,
  );
  if (typecheck_ok !== null) {
    lines.push(`| Typecheck | ${check(typecheck_ok)} ${typecheck_ok ? "clean" : "RED"} |`);
  }
  const previewIcon =
    preview_smoke.verdict === "pass" ? "✅" : preview_smoke.verdict === "fail" ? "❌" : "➖";
  lines.push(`| Preview smoke | ${previewIcon} ${preview_smoke.verdict} |`);
  if (preview_smoke.evidence_md.trim().length > 0) {
    lines.push("");
    lines.push("_Preview smoke notes:_");
    lines.push("");
    lines.push(preview_smoke.evidence_md.trim());
  }
  return lines.join("\n");
}

export function buildGatePrBody(summary: string, evidence: GateEvidence): string {
  const head = typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : "";
  const body = renderGateEvidenceMarkdown(evidence);
  return (head.length > 0 ? `${head}\n\n---\n\n${body}` : body).slice(0, 60000);
}

export interface RefineGateIo {
  loadEngineerParsed: (run_id: string) => Promise<Record<string, unknown> | null>;
  probePreview: (args: {
    tenant_id: string;
    repo: string;
    branch: string;
    run_id: string;
    expected_markers?: string[];
  }) => Promise<{ verdict: PreviewVerdict; evidence_md: string }>;
  openPrFromBranch: (args: {
    tenant_id: string;
    run_id: string;
    owner: string;
    repo: string;
    base_branch: string;
    head_branch: string;
    title: string;
    body: string;
  }) => Promise<{ ok: boolean; number?: number; url?: string; head_sha?: string; error?: string }>;
  addLabel: (args: {
    tenant_id: string;
    run_id: string;
    owner: string;
    repo: string;
    pull_number: number;
    label: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  writeGateResult: (args: {
    run_id: string;
    tenant_id: string;
    gate_evidence: GateEvidence;
    pr_url: string;
    pr_repo: string;
    pr_number: number | null;
    pr_head_branch: string;
    pr_head_sha: string;
  }) => Promise<void>;
  surfaceFailToThread: (args: {
    run_id: string;
    tenant_id: string;
    pr_url: string;
    evidence: GateEvidence;
  }) => Promise<void>;
}

export type RefineGateInput = {
  tenant_id: string;
  conductor_run_id: string;
  engineer_run_id: string | null;
  qa_run_id: string | null;
};

export type RefineGateResult =
  | { resolved: false; reason: string }
  | {
      resolved: true;
      gate_verdict: GateVerdict;
      pr_url: string | null;
      hold_reason?: typeof PROTECTED_PATH_HOLD_REASON;
    };

export function collectParsedFilePaths(
  parsed: Record<string, unknown> | null | undefined,
): string[] {
  const files = parsed?.files;
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const p = (f as { path?: unknown }).path;
    if (typeof p === "string" && p.trim().length > 0) out.push(p.trim());
  }
  return out;
}

export function collectExpectedMarkers(
  parsed: Record<string, unknown> | null | undefined,
): string[] {
  const meta = parsed?.refine_gate_meta as Record<string, unknown> | undefined;
  const raw = Array.isArray(parsed?.expected_markers)
    ? (parsed?.expected_markers as unknown[])
    : Array.isArray(meta?.expected_markers)
      ? (meta?.expected_markers as unknown[])
      : [];
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m === "string" && m.trim().length > 0) out.push(m.trim().slice(0, 200));
    if (out.length >= 10) break;
  }
  return out;
}

export function mergeProtectedHits(
  a: ProtectedPathHit[],
  b: ProtectedPathHit[],
): ProtectedPathHit[] {
  const byPath = new Map<string, ProtectedPathHit>();
  for (const h of [...a, ...b]) {
    if (!byPath.has(h.path)) byPath.set(h.path, h);
  }
  return [...byPath.values()];
}

export async function runRefineGate(
  input: RefineGateInput,
  io: RefineGateIo,
): Promise<RefineGateResult> {
  const { tenant_id, engineer_run_id, qa_run_id } = input;
  if (!engineer_run_id) return { resolved: false, reason: "no_engineer_run" };

  const parsed = await io.loadEngineerParsed(engineer_run_id);
  const metaRaw = parsed?.refine_gate_meta;
  if (!metaRaw || typeof metaRaw !== "object") {
    return { resolved: false, reason: "no_refine_gate_meta" };
  }
  const meta = metaRaw as Partial<RefineGateMeta>;
  const repo = typeof meta.repo === "string" ? meta.repo.trim() : "";
  const headBranch = typeof meta.head_branch === "string" ? meta.head_branch.trim() : "";
  const baseBranch =
    typeof meta.base_branch === "string" && meta.base_branch.trim() ? meta.base_branch.trim() : "main";
  const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : "Refine";
  if (!repo.includes("/") || !headBranch) {
    return { resolved: false, reason: "bad_refine_gate_meta" };
  }
  const [owner, repoName] = repo.split("/");

  const mechanical = {
    build_ok: meta.build_ok === true,
    tests_passed: typeof meta.tests_passed === "number" ? meta.tests_passed : 0,
    tests_failed: typeof meta.tests_failed === "number" ? meta.tests_failed : 0,
  };
  void qa_run_id;
  const preview = await io.probePreview({
    tenant_id,
    repo,
    branch: headBranch,
    run_id: engineer_run_id,
    expected_markers: collectExpectedMarkers(parsed),
  });
  const mechanicalPreviewVerdict = computeGateVerdict(mechanical, preview);

  const protectedHits = mergeProtectedHits(
    findProtectedPathHits(collectParsedFilePaths(parsed), [...DEFAULT_PROTECTED_GLOBS]),
    coerceProtectedPathHits(parsed?.protected_paths),
  );
  const holdOnProtectedPath = protectedHits.length > 0;
  const gate_verdict: GateVerdict = holdOnProtectedPath ? "fail" : mechanicalPreviewVerdict;
  const evidence: GateEvidence = {
    build_ok: mechanical.build_ok,
    tests: { passed: mechanical.tests_passed, failed: mechanical.tests_failed },
    typecheck_ok: typeof meta.typecheck_ok === "boolean" ? meta.typecheck_ok : null,
    preview_smoke: { verdict: preview.verdict, evidence_md: preview.evidence_md },
    gate_verdict,
    ...(holdOnProtectedPath ? { protected_paths: protectedHits } : {}),
  };

  const summary =
    typeof parsed?.rendered_markdown === "string"
      ? (parsed.rendered_markdown as string)
      : typeof parsed?.body === "string"
        ? (parsed.body as string)
        : "";
  const body = buildGatePrBody(summary, evidence);

  const opened = await io.openPrFromBranch({
    tenant_id,
    run_id: engineer_run_id,
    owner,
    repo: repoName,
    base_branch: baseBranch,
    head_branch: headBranch,
    title,
    body,
  });
  if (!opened.ok || !opened.url || typeof opened.number !== "number") {
    io_log_warn(
      `refine gate: PR open FAILED for ${repo} (run ${engineer_run_id}): ${opened.error ?? "no url/number"}`,
    );
    return { resolved: false, reason: "pr_open_failed" };
  }

  const label = gateLabel(gate_verdict);
  const labelRes = await io.addLabel({
    tenant_id,
    run_id: engineer_run_id,
    owner,
    repo: repoName,
    pull_number: opened.number,
    label,
  });
  if (!labelRes.ok) {
    io_log_warn(
      `refine gate: add_label(${label}) failed on ${repo}#${opened.number} (run ${engineer_run_id}): ${labelRes.error ?? "unknown"}`,
    );
  }

  await io.writeGateResult({
    run_id: engineer_run_id,
    tenant_id,
    gate_evidence: evidence,
    pr_url: opened.url,
    pr_repo: repo,
    pr_number: opened.number,
    pr_head_branch: headBranch,
    pr_head_sha: opened.head_sha ?? meta.commit_sha ?? "",
  });

  if (gate_verdict === "fail") {
    await io.surfaceFailToThread({
      run_id: engineer_run_id,
      tenant_id,
      pr_url: opened.url,
      evidence,
    });
  }

  return {
    resolved: true,
    gate_verdict,
    pr_url: opened.url,
    ...(holdOnProtectedPath ? { hold_reason: PROTECTED_PATH_HOLD_REASON } : {}),
  };
}

function io_log_warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[refine-gate] ${msg}`);
}

export const realRefineGateIo: RefineGateIo = {
  async loadEngineerParsed(run_id) {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("parsed")
      .eq("id", run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = (data as { parsed?: unknown } | null)?.parsed;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  },

  async probePreview(args) {
    const r = await probeBranchPreviewForRun({
      tenant_id: args.tenant_id,
      repo: args.repo,
      branch: args.branch,
      run_id: args.run_id,
      expected_markers: args.expected_markers,
    });
    return { verdict: r.verdict, evidence_md: r.evidence_md };
  },

  async openPrFromBranch(args) {
    const r = await callMcpTool(
      { tenant_id: args.tenant_id, run_id: args.run_id },
      "github",
      "open_pr_from_branch",
      {
        owner: args.owner,
        repo: args.repo,
        base_branch: args.base_branch,
        head_branch: args.head_branch,
        title: args.title,
        body: args.body,
      },
    );
    if (r.is_error) return { ok: false, error: r.content };
    try {
      const parsed = JSON.parse(r.content) as { number?: number; url?: string; head_sha?: string };
      return {
        ok: true,
        number: parsed.number,
        url: parsed.url,
        head_sha: parsed.head_sha,
      };
    } catch {
      return { ok: false, error: "open_pr_from_branch returned non-JSON" };
    }
  },

  async addLabel(args) {
    const r = await callMcpTool(
      { tenant_id: args.tenant_id, run_id: args.run_id },
      "github",
      "add_label",
      { owner: args.owner, repo: args.repo, pull_number: args.pull_number, labels: [args.label] },
    );
    return r.is_error ? { ok: false, error: r.content } : { ok: true };
  },

  async writeGateResult(args) {
    const sb = serviceClient();
    try {
      const { data } = await sb
        .from("agent_runs")
        .select("parsed")
        .eq("id", args.run_id)
        .maybeSingle();
      const prev = (data as { parsed?: unknown } | null)?.parsed;
      const base =
        prev && typeof prev === "object" && !Array.isArray(prev)
          ? (prev as Record<string, unknown>)
          : {};
      await sb
        .from("agent_runs")
        .update({ parsed: { ...base, gate_evidence: args.gate_evidence } })
        .eq("id", args.run_id);
    } catch (e) {
      io_log_warn(`writeGateResult parsed merge failed (run ${args.run_id}): ${(e as Error).message}`);
    }
    try {
      const { error } = await sb.rpc("agent_run_set_pr_meta", {
        p_run_id: args.run_id,
        p_pr_url: args.pr_url,
        p_pr_repo: args.pr_repo,
        p_pr_number: args.pr_number,
        p_pr_head_branch: args.pr_head_branch,
      });
      if (error) throw new Error(error.message);
    } catch (e) {
      io_log_warn(`writeGateResult pr_meta failed (run ${args.run_id}): ${(e as Error).message}`);
    }
    try {
      await logEvent({
        level: args.gate_evidence.gate_verdict === "fail" ? "warn" : "info",
        source: "refine-gate",
        code:
          args.gate_evidence.gate_verdict === "fail"
            ? "refine_gate_failed"
            : "refine_gate_passed",
        tenant_id: args.tenant_id,
        run_id: args.run_id,
        message: `refine gate ${args.gate_evidence.gate_verdict}: ${args.pr_url}`.slice(0, 500),
        meta: { tool_name: "refine-gate" },
      });
    } catch {
    }
  },

  async surfaceFailToThread(args) {
    try {
      const sb = serviceClient();
      const { data } = await sb
        .from("agent_runs")
        .select("output_text")
        .eq("id", args.run_id)
        .maybeSingle();
      const prev = (data as { output_text?: string | null } | null)?.output_text ?? "";
      const protectedHits = args.evidence.protected_paths ?? [];
      const note =
        protectedHits.length > 0
          ? `\n\n---\n**This change touches a protected path — a human must review it.** ` +
            `It edits ${describeProtectedHits(protectedHits)} (env / secrets / migrations / auth / billing / webhooks / middleware always need human review). ` +
            `I opened a PR (labeled \`${GATE_LABEL_FAIL}\`) so you can inspect it: ${args.pr_url}. Nothing was merged.`
          : `\n\n---\n**The review gate found issues — this change is NOT merge-ready.** ` +
            `I opened a PR (labeled \`${GATE_LABEL_FAIL}\`) so you can inspect the change + the ` +
            `build/test${args.evidence.preview_smoke.verdict === "fail" ? " + preview" : ""} evidence: ${args.pr_url}. ` +
            `Nothing was merged.`;
      await sb
        .from("agent_runs")
        .update({ output_text: `${prev}${note}`.slice(0, 60000) })
        .eq("id", args.run_id);
    } catch (e) {
      io_log_warn(`surfaceFailToThread failed (run ${args.run_id}): ${(e as Error).message}`);
    }
  },
};

export async function resolveRefineGate(input: RefineGateInput): Promise<RefineGateResult> {
  return runRefineGate(input, realRefineGateIo);
}
