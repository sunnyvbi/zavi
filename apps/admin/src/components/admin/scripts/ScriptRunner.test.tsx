import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api-admin", () => ({ adminApiFetch: vi.fn() }));

import { argsFrom, initialValues, ResultView, ScriptRunner } from "./ScriptRunner";
import type { FieldMeta, ScriptInfo } from "@/lib/scripts-api";

const fields: FieldMeta[] = [
  { name: "file", type: "file", label: "CSV", required: true },
  { name: "batch", type: "string", label: "Batch", required: true },
  { name: "max", type: "number", label: "Max", default: 100 },
  { name: "retry_failed", type: "boolean", label: "Retry", default: false },
];

const send: ScriptInfo = {
  key: "creator-send",
  group: "Creator invites",
  label: "Send invites",
  description: "Emails each creator once.",
  fields: fields.filter((f) => f.type !== "file"),
  applies: true,
  long_running: true,
  confirm_hint: "SEND <count>",
};

describe("ScriptRunner form values", () => {
  it("builds args from the fields: numbers as numbers, blanks dropped, files excluded", () => {
    const v = initialValues(fields);
    expect(v).toEqual({ batch: "", max: "100", retry_failed: false });
    expect(argsFrom(fields, { ...v, batch: " b1 " })).toEqual({ batch: "b1", max: 100, retry_failed: false });
  });
});

describe("ScriptRunner", () => {
  it("renders the form with Apply locked until a dry run", () => {
    const html = renderToStaticMarkup(<ScriptRunner script={send} runs={[]} onRunsChanged={() => {}} />);
    expect(html).toContain("Dry Run");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/);
    expect(html).toContain("Apply unlocks after a Dry Run with these inputs.");
  });
});

describe("ResultView", () => {
  it("send dry run lists who would be emailed by name and row, and flags settings problems", () => {
    const html = renderToStaticMarkup(
      <ResultView
        scriptKey="creator-send"
        result={{ eligible: 2, would_send: [{ sheet_row: 4, name: "Ada" }], skipped: [], problems: ["SYSTEM_SENDGRID_API_KEY is not set"], sender: { name: "Zavi Creators", email: "support@zaviagent.com" } }}
      />,
    );
    expect(html).toContain("Dry run: nothing was changed");
    expect(html).toContain("row 4 · Ada");
    expect(html).toContain("SYSTEM_SENDGRID_API_KEY is not set");
  });

  it("list hides an email the server did not return", () => {
    const html = renderToStaticMarkup(
      <ResultView scriptKey="creator-list" result={{ total: 1, by_label: { seeded: 1 }, rows: [{ sheet_row: 2, name: "A", email: null, has_email: true, label: "seeded", profiles: [] }] }} />,
    );
    expect(html).toContain("✓ (hidden)");
  });
});
