import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const BACKEND = join(__dirname, "..", "..", "..", "..");

const PINNED_GUARDS: Array<{ file: string; mustContain: string }> = [
  { file: "src/services/memory/loader.ts", mustContain: "PRIVATE_NOTE_TYPES" },
  { file: "src/services/tools/memory/agentic-read.ts", mustContain: "PRIVATE_NOTE_TYPE_SET.has" },
  { file: "src/services/memory/index.ts", mustContain: "PRIVATE_NOTE_TYPE_SET.has(n.note_type)" },
  { file: "src/services/memory/generate-anchors.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "src/services/mcp/server/zavi-inbound.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "src/services/memory/conflict-resolution.ts", mustContain: "PRIVATE_NOTE_TYPE_SET.has" },
  { file: "src/routes/memory/notes.ts", mustContain: "PRIVATE_NOTE_TYPE_SET.has" },
  { file: "src/services/agents/learnings.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "src/services/memory/feedback-recall.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "src/services/client-context/sections.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "src/services/tools/memory/_anchor-pending.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "workers/functions/dream-cycle.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
  { file: "src/services/memory/write-path.ts", mustContain: "PRIVATE_NOTE_TYPE_SET.has" },
  { file: "workers/functions/brain-judge-scan.ts", mustContain: "PRIVATE_NOTE_TYPES_PGREST_IN" },
];

const REGISTRY: Record<string, string> = {
  "src/routes/knowledge/import.ts": "human-surface",
  "src/services/knowledge-import/ask-conflict.ts": "human-surface",
  "src/services/knowledge-import/run-read.ts": "internal-meta",
  "src/services/setup/chat-fastpaths.ts": "writer",
  "src/services/setup/state.ts": "internal-meta",
  "src/services/company/brief.ts": "anchor-by-slug",
  "src/services/tools/memory/apply-anchor.ts": "anchor-by-slug",
  "src/services/agents/growth-strategy-block.ts": "recall-reader",
  "src/routes/workspace/growth-strategy-accept.ts": "human-surface",
  "src/routes/workspace/growth-interview.ts": "human-surface",
  "src/routes/workspace/growth-strategy.ts": "human-surface",
  "src/routes/workspace/growth-plan.ts": "human-surface",
  "src/services/growth/strategy-note.ts": "writer",
  "src/services/growth/founder-estimate.ts": "recall-reader",
  "src/services/company/suggestions.ts": "human-surface",
  "src/services/company/description-draft.ts": "human-surface",
  "src/services/tenants/new-tenant-alert.ts": "human-surface",
  "src/routes/admin/admin-tasks.ts": "human-surface",
  "src/routes/admin/company-facts-suggest.ts": "human-surface",
  "src/routes/admin/global-rules.ts": "human-surface",
  "src/routes/admin/memory.ts": "human-surface",
  "src/routes/admin/recall-trace.ts": "human-surface",
  "src/routes/agents/brain-anchors.ts": "human-surface",
  "src/routes/agents/dashboards/growth-lead.ts": "human-surface",
  "src/routes/agents/fundraising-round-config.ts": "human-surface",
  "src/routes/connectors/recommendations.ts": "human-surface",
  "src/routes/home/summary.ts": "human-surface",
  "src/routes/memory/notes.ts": "human-surface",
  "src/routes/agents/custom-agents.ts": "human-surface",
  "src/services/tools/memory/write.ts": "writer",
  "src/routes/onboarding/activate.ts": "writer",
  "src/routes/onboarding/gap-answer.ts": "writer",
  "src/routes/workspace/activation.ts": "human-surface",
  "src/services/workspace/morning-brief-assembler.ts": "human-surface",
  "src/services/agents/cron-outcome.ts": "internal-meta",
  "src/services/agents/deepagent/backends/zavi-memory-backend.ts": "recall-reader",
  "src/services/agents/learnings.ts": "recall-reader",
  "src/services/client-context/sections.ts": "recall-reader",
  "src/services/growth/fan-in.ts": "recall-reader",
  "src/services/mcp/server/zavi-inbound.ts": "recall-reader",
  "src/services/material-news/topics.ts": "recall-reader",
  "src/services/memory/conflict-resolution.ts": "recall-reader",
  "src/services/memory/distill-episode.ts": "writer",
  "src/services/memory/distill-gap.ts": "writer",
  "src/services/memory/dream-candidates.ts": "internal-meta",
  "src/services/memory/feedback-recall.ts": "recall-reader",
  "src/services/memory/generate-anchors.ts": "recall-reader",
  "src/services/memory/index.ts": "recall-reader",
  "src/services/memory/loader.ts": "owner-gated",
  "src/services/memory/patterns-job.ts": "internal-meta",
  "src/services/memory/write-path.ts": "recall-reader",
  "src/services/memory/remembered.ts": "human-surface",
  "workers/functions/memory-write-maintenance.ts": "internal-meta",
  "workers/functions/memory-dedup-cleanup.ts": "internal-meta",
  "src/services/personalization/summary.ts": "human-surface",
  "src/services/memory/recall-metrics.ts": "internal-meta",
  "src/services/memory/stamp-outcome.ts": "writer",
  "src/services/memory/valid-time.ts": "writer",
  "src/services/sandbox/repo-conventions.ts": "internal-meta",
  "src/services/tools/discovery/write-anchor.ts": "writer",
  "src/services/readiness/promote-draft.ts": "writer",
  "src/routes/admin/brain-drafts.ts": "human-surface",
  "workers/functions/readiness-scan.ts": "human-surface",
  "workers/functions/goal-proposer-scan.ts": "recall-reader",
  "src/services/memory/upsert-anchor.ts": "writer",
  "src/services/memory/fill-placeholder-docs.ts": "internal-meta",
  "src/services/tools/memory/_anchor-pending.ts": "recall-reader",
  "src/services/tools/memory/agentic-read.ts": "recall-reader",
  "workers/functions/agent-learn-weekly.ts": "writer",
  "workers/functions/brain-judge-scan.ts": "recall-reader",
  "workers/functions/distill-event.ts": "writer",
  "workers/functions/distill-skill-candidate.ts": "writer",
  "workers/functions/dream-cycle.ts": "recall-reader",
  "workers/functions/growth-lead-daily.ts": "internal-meta",
  "workers/functions/memory-enrichment.ts": "writer",
  "workers/functions/memory-note-enrich.ts": "writer",
  "workers/functions/memory-recall-canary.ts": "internal-meta",
  "workers/functions/memory-stale-note-archive.ts": "writer",
  "workers/functions/slack-w2-purge.ts": "writer",
};

describe("PRIVATE note-type isolation guard", () => {
  it("keeps the private-type exclusion in every fixed recall reader", () => {
    for (const { file, mustContain } of PINNED_GUARDS) {
      const src = readFileSync(join(BACKEND, file), "utf8");
      expect(src, `${file} lost its private-note guard (\`${mustContain}\`)`).toContain(mustContain);
    }
  });

  it("has NO memory_note reader outside the reviewed registry", () => {
    const MENTION = /from\(['"]memory_note['"]\)/;
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === "__tests__") continue;
          out.push(...walk(p));
        } else if (
          ent.name.endsWith(".ts") &&
          !ent.name.endsWith(".test.ts") &&
          MENTION.test(readFileSync(p, "utf8"))
        ) {
          out.push(relative(BACKEND, p));
        }
      }
      return out;
    };
    const files = [...walk(join(BACKEND, "src")), ...walk(join(BACKEND, "workers"))];
    const unregistered = files.filter((f) => !(f in REGISTRY));
    expect(
      unregistered,
      `New memory_note reader(s) not classified for private-type isolation. ` +
        `For each: if its output can reach another agent or an external caller, exclude ` +
        `PRIVATE_NOTE_TYPES (or owner-gate by agent_slug); then add it to REGISTRY here.\n` +
        unregistered.join("\n"),
    ).toEqual([]);
  });
});
