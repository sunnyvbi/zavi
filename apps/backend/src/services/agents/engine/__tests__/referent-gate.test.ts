
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  isEligibleDoc,
  mentionsDocumentReferent,
} from "../referent-gate";
import {
  __resetDocLedgerForTests,
  hasAnyRetrieval,
  hasRetrievedAnyOf,
  recordDocRetrieval,
  recordRetrievalFailure,
  recordThreadAttachments,
  threadAttachments,
} from "../doc-ledger";

beforeEach(() => {
  __resetDocLedgerForTests();
  vi.restoreAllMocks();
});

describe("mentionsDocumentReferent — arms only on a NAMED document", () => {
  it("fires on the exact phrasing that caused the incident", () => {
    expect(mentionsDocumentReferent("@Zavi implement this plan and send PR")).toBe(true);
  });

  it.each([
    "implement the attached spec",
    "build the plan in the PDF",
    "review this document please",
    "use the file I sent",
    "ship that spec",
  ])("fires on %j", (msg) => {
    expect(mentionsDocumentReferent(msg)).toBe(true);
  });

  it.each([
    "fix that bug in the checkout flow",
    "ship this",
    "can you look at this?",
    "deploy that",
    "this is broken, please investigate",
    "Build a public what's-my-car-worth calculator and deploy it",
    "Draft a set of QA test cases for our booking/checkout flow.",
  ])("does NOT fire on %j", (msg) => {
    expect(mentionsDocumentReferent(msg)).toBe(false);
  });

  it("does not fire on empty/absent text", () => {
    expect(mentionsDocumentReferent("")).toBe(false);
    expect(mentionsDocumentReferent(null)).toBe(false);
    expect(mentionsDocumentReferent(undefined)).toBe(false);
  });
});

describe("isEligibleDoc — only real documents arm the gate", () => {
  it("accepts document types", () => {
    expect(isEligibleDoc({ filetype: "pdf", name: "plan.pdf" })).toBe(true);
    expect(isEligibleDoc({ filetype: "docx", name: "spec.docx" })).toBe(true);
    expect(isEligibleDoc({ filetype: "", name: "notes.md" })).toBe(true);
  });

  it("rejects images and other non-documents", () => {
    expect(isEligibleDoc({ filetype: "png", name: "Screenshot.png" })).toBe(false);
    expect(isEligibleDoc({ filetype: "jpg", name: "photo.jpg" })).toBe(false);
    expect(isEligibleDoc({ filetype: "mp4", name: "clip.mp4" })).toBe(false);
  });
});

describe("doc-ledger — a FAILED read must never look like a successful one", () => {
  it("records presence without implying retrieval", () => {
    recordThreadAttachments("run-1", [
      { file_id: "F1", name: "plan.pdf", filetype: "pdf" },
    ]);
    expect(threadAttachments("run-1")).toHaveLength(1);
    expect(hasAnyRetrieval("run-1")).toBe(false);
  });

  it("a failed read does NOT satisfy the gate", () => {
    recordThreadAttachments("run-2", [
      { file_id: "F2", name: "scan.pdf", filetype: "pdf" },
    ]);
    recordRetrievalFailure("run-2", { ref: "F2", reason: "file_unreadable" });
    expect(hasAnyRetrieval("run-2")).toBe(false);
  });

  it("a successful, non-empty read satisfies the gate", () => {
    recordDocRetrieval("run-3", {
      source: "slack_file",
      ref: "F3",
      artifact_id: null,
      chars: 4200,
    });
    expect(hasAnyRetrieval("run-3")).toBe(true);
  });

  it("an EMPTY read is not a read", () => {
    recordDocRetrieval("run-4", {
      source: "slack_file",
      ref: "F4",
      artifact_id: null,
      chars: 0,
    });
    expect(hasAnyRetrieval("run-4")).toBe(false);
  });

  it("keeps ledgers isolated per run", () => {
    recordDocRetrieval("run-a", {
      source: "chat_doc",
      ref: "p",
      artifact_id: null,
      chars: 10,
    });
    expect(hasAnyRetrieval("run-a")).toBe(true);
    expect(hasAnyRetrieval("run-b")).toBe(false);
  });

  it("reading the WRONG document does not satisfy the gate for the right one", () => {
    recordDocRetrieval("run-5", {
      source: "slack_file",
      ref: "F_OTHER",
      artifact_id: null,
      chars: 900,
    });
    expect(hasAnyRetrieval("run-5")).toBe(true);
    expect(hasRetrievedAnyOf("run-5", ["F_WANTED"])).toBe(false);
    expect(hasRetrievedAnyOf("run-5", ["F_OTHER"])).toBe(true);
  });

  it("hasRetrievedAnyOf is false when nothing was read", () => {
    expect(hasRetrievedAnyOf("run-6", ["F1"])).toBe(false);
    expect(hasRetrievedAnyOf("run-6", [])).toBe(false);
  });
});
