
import { describe, expect, it } from "vitest";
import { mapFiles, trimToCap } from "../read_thread";

describe("mapFiles", () => {
  it("surfaces the file the incident thread carried", () => {
    const refs = mapFiles([
      {
        id: "F0BGW6AERQS",
        name: "private-rents-meta-pixel-plan.pdf",
        filetype: "pdf",
        size: 23242,
      },
    ]);
    expect(refs).toEqual([
      {
        file_id: "F0BGW6AERQS",
        name: "private-rents-meta-pixel-plan.pdf",
        filetype: "pdf",
        size: 23242,
      },
    ]);
  });

  it("returns undefined when there are no files (no empty arrays in the payload)", () => {
    expect(mapFiles(undefined)).toBeUndefined();
    expect(mapFiles([])).toBeUndefined();
  });

  it("drops files with no id and caps a pathological upload burst", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `F${i}`,
      name: `f${i}.pdf`,
      filetype: "pdf",
      size: 1,
    }));
    expect(mapFiles([{ name: "no-id.pdf" }, ...many])).toHaveLength(8);
  });
});

describe("trimToCap — the trim must not evict the newest message", () => {
  const bigText = "x".repeat(3000);

  it("keeps the ROOT and the NEWEST message under byte pressure", () => {
    const msgs = [
      { ts: "1", user: "U1", text: `root ${bigText}` },
      { ts: "2", user: "U1", text: `middle ${bigText}` },
      { ts: "3", user: "U1", text: `middle2 ${bigText}` },
      { ts: "4", user: "U1", text: "implement this plan and send PR" },
    ];
    const { messages, truncated } = trimToCap(msgs);

    expect(truncated).toBe(true);
    expect(messages[0].ts).toBe("1");
    expect(messages[messages.length - 1].ts).toBe("4");
    expect(messages.some((m) => m.ts === "4")).toBe(true);
  });

  it("preserves attachment refs even when text has to be shrunk", () => {
    const msgs = [
      {
        ts: "1",
        user: "U1",
        text: bigText,
        files: [
          { file_id: "F1", name: "plan.pdf", filetype: "pdf", size: 100 },
        ],
      },
      { ts: "2", user: "U1", text: bigText },
    ];
    const { messages } = trimToCap(msgs);
    expect(messages[0].files?.[0].file_id).toBe("F1");
  });

  it("leaves a small thread untouched", () => {
    const msgs = [
      { ts: "1", user: "U1", text: "hi" },
      { ts: "2", user: "U1", text: "there" },
    ];
    const { messages, truncated } = trimToCap(msgs);
    expect(messages).toHaveLength(2);
    expect(truncated).toBe(false);
  });
});
