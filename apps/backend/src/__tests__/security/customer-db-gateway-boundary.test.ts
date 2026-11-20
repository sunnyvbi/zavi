import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const ROOT = join(__dirname, "../../..");
const SCAN = [join(ROOT, "src"), join(ROOT, "workers"), join(ROOT, "server.ts")];
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DRIVERS = new Set(["pg", "mongodb", "mysql2", "mysql2/promise", "@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"]);

type Spec = { text: string | null; typeOnly: boolean };

function specifiers(file: string): Spec[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: Spec[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ text: n.moduleSpecifier.text, typeOnly: !!n.importClause?.isTypeOnly });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ text: n.moduleSpecifier.text, typeOnly: n.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      out.push({ text: ts.isStringLiteral(e) ? e.text : null, typeOnly: n.isTypeOnly });
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    ) {
      const a = n.arguments[0];
      out.push({ text: a && ts.isStringLiteralLike(a) ? a.text : null, typeOnly: false });
    } else if (ts.isImportTypeNode(n)) {
      const lit = n.argument;
      if (ts.isLiteralTypeNode(lit) && ts.isStringLiteral(lit.literal)) out.push({ text: lit.literal.text, typeOnly: true });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function toRepoPath(file: string, spec: string): string {
  if (spec.startsWith("@/")) return relative(ROOT, join(ROOT, "src", spec.slice(2)));
  if (spec.startsWith(".")) return relative(ROOT, resolve(dirname(file), spec));
  return spec;
}

const DRIVER_ALLOWED: Record<string, string> = {
  "src/services/data-gateway/direct/sql.ts": "gateway SQL connection",
  "src/services/data-gateway/direct/mongo.ts": "gateway Mongo connection",
  "src/services/data-gateway/direct/dynamo.ts": "gateway DynamoDB connection",
  "src/services/data-gateway/discovery/postgres.ts": "structure scan",
  "src/services/data-gateway/discovery/mysql.ts": "structure scan",
  "src/services/data-gateway/discovery/mongo.ts": "structure scan",
  "src/services/data-gateway/discovery/dynamodb.ts": "structure scan",
  "src/services/data-gateway/discovery/privilege.ts": "read-only check",
  "src/services/tools/operator-db/query-input-coerce.ts": "ObjectId value type only, no connection",
  "src/services/tools/operator-db/drivers/mongo.ts": "ObjectId value type only, no connection",
  "src/services/website/app-data.ts": "Zavi-hosted site databases, not a customer database",
  "src/services/site-auth/store.ts": "Zavi-hosted site auth store",
  "src/services/provisioning/managed-operator-db.ts": "creates the read-only role on a database Zavi hosts; never reads rows",
  "src/services/evals/operator-db-analytics/fixtures/load.ts": "eval fixture databases",
};
const GATEWAY_INTERNAL = /^src\/services\/data-gateway\/(direct|discovery)\//;
const PERSON = /^src\/services\/data-gateway\/person(\.ts)?$/;
const PERSON_ALLOWED = new Set(["src/services/comms/bulk-outbound/database-import.ts", "src/services/tools/operator-db/row-browser.ts"]);
const NON_LITERAL_ALLOWED: Record<string, string> = {
  "src/services/connectors/discord/gateway.ts": 'optional dependency, constant "discord.js"',
  "src/services/connectors/teams/adapter.ts": 'optional dependency, constant "botbuilder"',
  "src/services/evals/agent-behavior-detector-stability.ts": "eval harness loads a built detector file by path",
  "src/services/launch-video/capture-bridge.ts": 'optional dependency, "playwright" as string',
  "src/services/qa/showability-gate.ts": 'optional dependency, "playwright" as string',
};

const SECRET_MARKER = /connection_secret_key|operator_db\./;

export function secretReadViolations(rel: string, src: string): string[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const fns = new Set<string>(["getSecret"]);
  const tainted = new Set<string>();
  const decls: Array<{ name: string; init: ts.Node }> = [];
  const idsIn = (n: ts.Node): string[] => {
    const ids: string[] = [];
    const v = (x: ts.Node) => {
      if (ts.isIdentifier(x)) ids.push(x.text);
      ts.forEachChild(x, v);
    };
    v(n);
    return ids;
  };
  const isGetSecretRef = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && fns.has(e.text)) ||
    (ts.isPropertyAccessExpression(e) && e.name.text === "getSecret") ||
    (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === "getSecret");
  const collect = (n: ts.Node) => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === "getSecret") fns.add(n.name.text);
    if (ts.isExportSpecifier(n) && (n.propertyName ?? n.name).text === "getSecret") out.push(`${rel}: re-exports getSecret outside the data gateway`);
    if (ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && /secrets\/vault/.test(n.moduleSpecifier.text)) {
      out.push(`${rel}: re-exports the secrets vault outside the data gateway`);
    }
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
      const prop = n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName.text : n.name.text;
      if (prop === "getSecret") fns.add(n.name.text);
      if (prop === "connection_secret_key") tainted.add(n.name.text);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (isGetSecretRef(n.initializer)) fns.add(n.name.text);
      if (SECRET_MARKER.test(n.initializer.getText(sf))) tainted.add(n.name.text);
      decls.push({ name: n.name.text, init: n.initializer });
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      if (SECRET_MARKER.test(n.right.getText(sf))) tainted.add(n.left.text);
      decls.push({ name: n.left.text, init: n.right });
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      if (tainted.has(d.name)) continue;
      if (idsIn(d.init).some((id) => tainted.has(id))) {
        tainted.add(d.name);
        changed = true;
      }
    }
  }
  const check = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isGetSecretRef(n.expression)) {
      const hit = n.arguments.some((a) => SECRET_MARKER.test(a.getText(sf)) || idsIn(a).some((id) => tainted.has(id)));
      if (hit) out.push(`${rel}: reads a customer database secret outside the data gateway`);
    }
    ts.forEachChild(n, check);
  };
  check(sf);
  return out;
}

function walk(p: string, out: string[]): void {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isFile()) {
    if (EXT.test(p) && !/\.test\.|\.spec\.|\.d\.ts$/.test(p)) out.push(p);
    return;
  }
  for (const name of readdirSync(p)) {
    if (name === "node_modules" || name === "__tests__" || name === "__mocks__" || name === "dist" || name === "files") continue;
    walk(join(p, name), out);
  }
}

function collect() {
  const files: string[] = [];
  for (const s of SCAN) walk(s, files);
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    const inGateway = rel.startsWith("src/services/data-gateway/");
    for (const sp of specifiers(file)) {
      if (sp.text === null) {
        if (!NON_LITERAL_ALLOWED[rel]) violations.push(`${rel}: non-literal dynamic import/require`);
        continue;
      }
      if (!sp.typeOnly && DRIVERS.has(sp.text) && !DRIVER_ALLOWED[rel]) {
        violations.push(`${rel}: imports database driver "${sp.text}" outside the data gateway`);
      }
      const target = toRepoPath(file, sp.text).replace(/\.(ts|js)$/, "");
      if (GATEWAY_INTERNAL.test(target) && !inGateway && !sp.typeOnly) {
        violations.push(`${rel}: imports gateway internal "${sp.text}"`);
      }
      if (PERSON.test(target) && !PERSON_ALLOWED.has(rel) && !inGateway) {
        violations.push(`${rel}: imports the person-read module "${sp.text}"`);
      }
    }
    if (!inGateway && rel !== "src/services/secrets/vault.ts") violations.push(...secretReadViolations(rel, readFileSync(file, "utf8")));
  }
  return { files, violations };
}

describe("customer-database connections go through the data gateway only", () => {
  it("scans a real tree", () => {
    expect(collect().files.length).toBeGreaterThan(500);
  });
  it("has no boundary violations", () => {
    expect(collect().violations).toEqual([]);
  });
  it("catches a new file that opens its own connection (self-check on a synthetic source)", () => {
    const fake = join(ROOT, "src/services/growth/__boundary_probe__.ts");
    const sf = ts.createSourceFile(fake, 'const { Client } = require("pg"); import("mongodb"); const m = "x"; require(m);', ts.ScriptTarget.Latest, true);
    const found: Array<string | null> = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        const a = n.arguments[0];
        found.push(a && ts.isStringLiteralLike(a) ? a.text : null);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toEqual(["pg", "mongodb", null]);
  });
  describe("secret-read scan catches each bypass form (self-tests on synthetic sources)", () => {
    const rel = "src/services/growth/__boundary_probe__.ts";
    const cases: Record<string, string> = {
      "direct call": 'import { getSecret } from "@/services/secrets/vault"; await getSecret(t, row.connection_secret_key);',
      "aliased import": 'import { getSecret as readSecret } from "@/services/secrets/vault"; const key = row.connection_secret_key; await readSecret(tenantId, key);',
      "namespace import": 'import * as vault from "@/services/secrets/vault"; await vault.getSecret(t, `operator_db.${id}`);',
      "element access": 'import * as vault from "@/services/secrets/vault"; await vault["getSecret"](t, row.connection_secret_key);',
      "destructured require": 'const { getSecret: g } = require("@/services/secrets/vault"); g(t, row.connection_secret_key);',
      "function alias": 'import { getSecret } from "@/services/secrets/vault"; const f = getSecret; f(t, row.connection_secret_key);',
      "variable alias chain": 'import { getSecret } from "@/services/secrets/vault"; const a = row.connection_secret_key; const b = a; const c = String(b); await getSecret(t, c);',
      "destructured key": 'import { getSecret } from "@/services/secrets/vault"; const { connection_secret_key: k } = row; await getSecret(t, k);',
      "assignment": 'import { getSecret } from "@/services/secrets/vault"; let k; k = cfg.connection_secret_key; await getSecret(t, k);',
      "re-export": 'export { getSecret as readIt } from "@/services/secrets/vault";',
      "star re-export": 'export * from "@/services/secrets/vault";',
    };
    for (const [name, src] of Object.entries(cases)) {
      it(name, () => {
        expect(secretReadViolations(rel, src).length).toBeGreaterThan(0);
      });
    }
    it("leaves an unrelated secret read alone", () => {
      expect(secretReadViolations(rel, 'import { getSecret } from "@/services/secrets/vault"; const k = "slack_bot_token"; await getSecret(t, k);')).toEqual([]);
    });
  });
});
