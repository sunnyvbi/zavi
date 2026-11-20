const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const { friendlyError } = loadTs(path.join(__dirname, "../src/components/ErrorCard.tsx"), {
  "react-native": { StyleSheet: { create: (s) => s } },
  "../theme/tokens": { font: { family: {} } },
  "../theme/theme": { useStyles: () => ({}) },
});

const apiError = (status, message) => Object.assign(new Error(message), { status });

test("a 4xx keeps the server's message, so a library attach says what is wrong", () => {
  assert.equal(friendlyError(apiError(400, "That file is over 10MB."), "x"), "That file is over 10MB.");
  assert.equal(friendlyError(apiError(404, "That file is not available."), "x"), "That file is not available.");
  assert.equal(
    friendlyError(apiError(400, "Zavi can only attach images, PDF, DOCX, CSV, TXT or Markdown files."), "x"),
    "Zavi can only attach images, PDF, DOCX, CSV, TXT or Markdown files.",
  );
});

test("a 5xx or a dropped network shows the plain outage line, not the raw text", () => {
  const down = "We couldn't reach Zavi right now. Please try again in a moment.";
  assert.equal(friendlyError(apiError(502, "Could not read that file."), "x"), down);
  assert.equal(friendlyError(new Error("Network request failed"), "x"), down);
  assert.equal(friendlyError(new Error('{"error":"boom"}'), "x"), down);
});

test("nothing to say falls back to the caller's line", () => {
  assert.equal(friendlyError(new Error("  "), "Couldn't attach a.pdf."), "Couldn't attach a.pdf.");
  assert.equal(friendlyError(undefined, "Couldn't attach a.pdf."), "Couldn't attach a.pdf.");
  assert.equal(friendlyError("Max 4 images per message.", "x"), "Max 4 images per message.");
});
