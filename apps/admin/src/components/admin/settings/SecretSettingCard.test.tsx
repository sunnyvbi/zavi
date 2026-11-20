import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
import { SecretSettingCard, type SecretSettingRow } from "./SecretSettingCard";

const base: SecretSettingRow = {
  key: "anthropic_oauth_token_pool",
  description: "Claude subscription OAuth tokens",
  scope: "global",
  globalValue: "••• set (hidden)",
  secretItems: ["…1111", "…2222"],
  secretRevision: "2026-10-21T17:30:00.123456+00:00",
};

const render = (row: SecretSettingRow) => renderToStaticMarkup(<SecretSettingCard row={row} onSaveGlobal={vi.fn()} />);

it("shows each token's hint, seat and note, with note and replace controls", () => {
  const html = render({
    ...base,
    notesAvailable: true,
    secretEntries: [
      { hint: "…1111", seat: "seat_0ed450acbb54", note: "Ravi's Max seat, renews 11-03", note_updated_by: "ravi@upcar.ai", note_updated_at: "2026-10-21T18:00:00Z" },
      { hint: "…2222", seat: "seat_fcccd54ed4d5", note: null, note_updated_by: null, note_updated_at: null },
    ],
  });
  expect(html).toContain("2 configured");
  expect(html).toContain("seat_0ed450acbb54");
  expect(html).toContain("Ravi&#x27;s Max seat, renews 11-03");
  expect(html).toContain("note by ravi@upcar.ai");
  expect(html).toContain("edit note");
  expect(html).toContain("add note");
  expect(html).toContain("no note");
  expect(html).toContain(">replace<");
  expect(html).toContain("note (optional)");
  expect(html).not.toContain("set (hidden)\"");
});

it("hides note editing and says why when the server can't do notes", () => {
  const html = render({
    ...base,
    notesAvailable: false,
    secretEntries: [{ hint: "…1111", seat: "seat_0ed450acbb54", note: null, note_updated_by: null, note_updated_at: null }],
  });
  expect(html).toContain("Notes are unavailable");
  expect(html).not.toContain("add note");
  expect(html).not.toContain("note (optional)");
  expect(html).toContain(">replace<");
});

it("falls back to hint-only rows against an older backend", () => {
  const html = render(base);
  expect(html).toContain("…1111");
  expect(html).toContain("…2222");
  expect(html).not.toContain("add note");
  expect(html).not.toContain(">replace<");
  expect(html).not.toContain("Notes are unavailable");
});

it("an empty pool reads as not configured", () => {
  expect(render({ ...base, globalValue: "", secretItems: [], secretEntries: [], notesAvailable: true })).toContain("not configured");
});
