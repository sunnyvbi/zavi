const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/invites/outcome.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
const { inviteFailure } = mod.exports;

test("each backend answer maps to its screen", () => {
  assert.equal(inviteFailure({ status: 409, code: "already_accepted" }), "already");
  assert.equal(inviteFailure({ status: 410, code: "invite_revoked" }), "revoked");
  assert.equal(inviteFailure({ status: 403, code: "email_mismatch" }), "wrong");
  assert.equal(inviteFailure({ status: 401, code: "unauthenticated" }), "signedout");
  assert.equal(inviteFailure({ status: 404, code: "not_found" }), "notfound");
  assert.equal(inviteFailure({ status: 400, code: "invalid_argument" }), "notfound");
});

test("a network error or anything unexpected stays on the Join screen", () => {
  assert.equal(inviteFailure(new TypeError("Network request failed")), "failed");
  assert.equal(inviteFailure({ status: 500, code: "internal" }), "failed");
  assert.equal(inviteFailure(undefined), "failed");
});
