import { describe, it, expect } from "vitest";
import {
  scoreKnowledgeUpdate,
  scoreAbstention,
  paraphraseDuplicateRate,
  ABSTAIN_MAX_SCORE,
} from "../write-canary";

describe("write-path recall canaries", () => {
  it("knowledge update: the new note comes back and the replaced one does not", () => {
    expect(scoreKnowledgeUpdate([{ note_id: "new" }, { note_id: "x" }], "new", "old")).toBe("pass");
    expect(scoreKnowledgeUpdate([{ note_id: "new" }, { note_id: "old" }], "new", "old")).toBe("fail");
    expect(scoreKnowledgeUpdate([{ note_id: "x" }], "new", "old")).toBe("fail");
  });

  it("abstention: nothing confident for a question the brain cannot answer", () => {
    expect(scoreAbstention([])).toBe("pass");
    expect(scoreAbstention([{ score: ABSTAIN_MAX_SCORE - 0.01 }])).toBe("pass");
    expect(scoreAbstention([{ score: 0.9 }])).toBe("fail");
  });

  it("paraphrase-duplicate rate", () => {
    expect(paraphraseDuplicateRate({ added: 6, duplicate: 3, updated: 1, conflict: 0 })).toBeCloseTo(0.3);
    expect(paraphraseDuplicateRate({ added: 0, duplicate: 0, updated: 0, conflict: 0 })).toBe(0);
  });
});
