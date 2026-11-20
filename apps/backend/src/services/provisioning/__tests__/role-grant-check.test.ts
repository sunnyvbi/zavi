import { describe, it, expect } from "vitest";
import {
  detectUnsafeRoleGrant,
  formatRoleGrantError,
  type RoleGrantRule,
} from "../role-grant-check";
import { BLESSED_TEMPLATE_FILES, readBlessedTemplate } from "@/services/agents/codegen-templates";
import { buildStarterFiles } from "../templates/starters";

const scan = (path: string, content: string) => detectUnsafeRoleGrant([{ path, content }]);
const rulesOf = (path: string, content: string): RoleGrantRule[] => scan(path, content).map((h) => h.rule);

describe("detectUnsafeRoleGrant — catches", () => {
  const cases: Array<[string, string, string, RoleGrantRule]> = [
    [
      "UPDATE users SET role",
      "app/api/promote/route.ts",
      `await query("UPDATE users SET role = 'admin' WHERE id = $1", [id]);`,
      "sql_role_write",
    ],
    [
      "multi-line UPDATE users SET ... role",
      "lib/users.ts",
      "await query(`\n  UPDATE users\n  SET name = $1,\n      role = $2\n  WHERE id = $3`, [n, r, id]);",
      "sql_role_write",
    ],
    [
      "UPDATE any table SET is_admin",
      "lib/members.ts",
      `await query("UPDATE members SET is_admin = true WHERE user_id = $1", [uid]);`,
      "sql_role_write",
    ],
    [
      "UPDATE users AS u SET role",
      "app/api/promote/route.ts",
      `await query("UPDATE users AS u SET role = $1 WHERE u.id = $2", [r, id]);`,
      "sql_role_write",
    ],
    [
      "UPDATE users u SET role (bare alias)",
      "app/api/promote/route.ts",
      `await query("UPDATE users u SET role = 'admin' WHERE u.id = $1", [id]);`,
      "sql_role_write",
    ],
    [
      "UPDATE public.users SET role",
      "app/api/promote/route.ts",
      `await query("UPDATE public.users SET role = 'admin' WHERE id = $1", [id]);`,
      "sql_role_write",
    ],
    [
      'UPDATE "public"."users" AS u SET "role"',
      "lib/users.ts",
      'await query(`UPDATE "public"."users" AS u SET "role" = $1 WHERE u.id = $2`, [r, id]);',
      "sql_role_write",
    ],
    [
      'UPDATE "users" usr SET name, role (multi-line)',
      "lib/users.ts",
      'await query(`\n  UPDATE "users" usr\n  SET name = $1,\n      role = $2\n  WHERE usr.id = $3`, [n, r, id]);',
      "sql_role_write",
    ],
    [
      "UPDATE members AS m SET is_admin",
      "lib/members.ts",
      `await query("UPDATE members AS m SET is_admin = true WHERE m.user_id = $1", [uid]);`,
      "sql_role_write",
    ],
    [
      "INSERT INTO users (... role ...)",
      "app/api/register/route.ts",
      `await query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)", [e, h, r]);`,
      "sql_role_write",
    ],
    [
      "INSERT INTO admins",
      "app/api/register/route.ts",
      `await query("INSERT INTO admins (user_id) VALUES ($1)", [uid]);`,
      "sql_role_write",
    ],
    [
      "ON CONFLICT DO UPDATE SET role",
      "scripts/seed.mjs",
      `await c.query("INSERT INTO accounts (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET role = 'admin'", [e]);`,
      "sql_role_write",
    ],
    [
      "drizzle .update(users).set({ role })",
      "app/actions.ts",
      `await db.update(users).set({ role: body.role }).where(eq(users.id, id));`,
      "orm_role_write",
    ],
    [
      "prisma data: { isAdmin: true }",
      "app/actions.ts",
      `await prisma.user.update({ where: { id }, data: { isAdmin: true } });`,
      "orm_role_write",
    ],
    [
      "role literal 'owner' assigned at signup",
      "app/api/signup/route.ts",
      `const role = "owner";\nconst u = { email, role };`,
      "role_literal_grant",
    ],
    [
      "first user becomes admin (count(*) = 0)",
      "app/api/signup/route.ts",
      [
        `const { rows } = await query("SELECT count(*)::int AS n FROM users");`,
        `const role = rows[0].n === 0 ? "admin" : "user";`,
      ].join("\n"),
      "first_user_grant",
    ],
    [
      "first user via rowCount === 0",
      "app/api/signup/route.ts",
      [
        `const existing = await query("SELECT id FROM users LIMIT 1");`,
        `if (existing.rowCount === 0) {`,
        `  isOwner = true;`,
        `}`,
      ].join("\n"),
      "first_user_grant",
    ],
    [
      "role from ADMIN_EMAIL env",
      "lib/admin.ts",
      `export const isAdmin = (u: { email: string }) => u.email === process.env.ADMIN_EMAIL;`,
      "email_or_env_grant",
    ],
    [
      "role from email literal",
      "lib/admin.ts",
      `if (user.email === "founder@acme.com") return true;`,
      "email_or_env_grant",
    ],
    [
      "role from an admin email list",
      "lib/admin.ts",
      `const ok = adminEmails.includes(user.email);`,
      "email_or_env_grant",
    ],
  ];

  for (const [name, path, content, rule] of cases) {
    it(name, () => {
      const hits = scan(path, content);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.map((h) => h.rule)).toContain(rule);
      expect(hits[0].file).toBe(path);
    });
  }

  it("role literals in ORM WRITE objects are still grants (read-filter exemption does not cover them)", () => {
    const writes: Array<[string, string]> = [
      ["prisma create data", `await prisma.user.create({ data: { email, role: "admin" } });`],
      ["prisma update data after a where", `await prisma.user.update({ where: { id }, data: { role: "admin" } });`],
      ["prisma updateMany demoting by filter, promoting in data", `await prisma.user.updateMany({ where: { role: "user" }, data: { role: 'owner' } });`],
      ["prisma upsert create", `await prisma.user.upsert({ where: { email }, create: { email, role: "admin" }, update: {} });`],
      ["drizzle insert values object", `await db.insert(users).values({ email, role: 'admin' });`],
      ["knex insert object", `await knex("users").insert({ email, role: "admin" });`],
      ["plain object then insert", `const row = { email, role: "admin" };\nawait insertUser(row);`],
      ["multi-line prisma create", `await prisma.user.create({\n  data: {\n    email,\n    role: "admin",\n  },\n});`],
    ];
    for (const [name, src] of writes) {
      expect(scan("app/api/x/route.ts", src).length, name).toBeGreaterThan(0);
    }
  });

  it("reports the line where the grant starts", () => {
    const hits = scan("lib/x.ts", `const a = 1;\n\nawait query("UPDATE users SET role = $1 WHERE id = $2", [r, id]);`);
    expect(hits).toEqual([{ file: "lib/x.ts", line: 3, rule: "sql_role_write" }]);
  });

  it("the blessed redeemInvite line is flagged when it is pasted outside lib/auth.ts", () => {
    const line = `    await c.query("UPDATE users SET role = $1 WHERE id = $2 AND role = 'user'", [role, userId]);`;
    expect(rulesOf("app/api/claim/route.ts", line)).toEqual(["sql_role_write"]);
  });

  it("an EDITED blessed lib/auth.ts is scanned (only byte-identical blessed lines are exempt)", () => {
    const auth = readBlessedTemplate("auth-lib.ts.template") + `\nexport async function makeMeAdmin(uid: number) {\n  await query("UPDATE users SET role = 'admin' WHERE id = $1", [uid]);\n}\n`;
    const hits = scan("lib/auth.ts", auth);
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe("sql_role_write");
  });
});

describe("detectUnsafeRoleGrant — blessed exemption is exact", () => {
  it("a second copy of the blessed redeemInvite UPDATE inside lib/auth.ts is flagged", () => {
    const line = `    await c.query("UPDATE users SET role = $1 WHERE id = $2 AND role = 'user'", [role, userId]);`;
    const auth = readBlessedTemplate("auth-lib.ts.template") + `\nexport async function grant(c: any, role: string, userId: number) {\n${line}\n}\n`;
    expect(scan("lib/auth.ts", auth).map((h) => h.rule)).toContain("sql_role_write");
  });
});

describe("detectUnsafeRoleGrant — must not touch", () => {
  it("every blessed template at its shipped path", () => {
    for (const { target, source } of BLESSED_TEMPLATE_FILES) {
      expect(scan(target, readBlessedTemplate(source)), target).toEqual([]);
    }
  });

  it("the whole auth starter (roles migration, invite-aware pages)", () => {
    const files = Object.entries(buildStarterFiles("auth")).map(([path, content]) => ({ path, content }));
    expect(detectUnsafeRoleGrant(files)).toEqual([]);
  });

  it("migrate SQL creating the enum with DEFAULT 'user'", () => {
    const sql = [
      "const MIGRATIONS = [",
      "  `DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('user', 'admin');",
      "   EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,",
      "  `CREATE TABLE IF NOT EXISTS users (id bigserial PRIMARY KEY, email text UNIQUE NOT NULL,",
      "     role public.app_role NOT NULL DEFAULT 'user')`,",
      "];",
    ].join("\n");
    expect(scan("scripts/migrate.mjs", sql)).toEqual([]);
  });

  it("a page that only READS role", () => {
    const page = [
      `const user = await currentUser();`,
      `const rows = await query("SELECT id FROM posts");`,
      `if (rows.length === 0) return <Empty />;`,
      `if (user.role === "admin") return <AdminBar />;`,
      `const isAdmin = user?.role === "admin";`,
      `return <Nav isAdmin={user.role !== "user"} />;`,
    ].join("\n");
    expect(scan("app/dashboard/page.tsx", page)).toEqual([]);
  });

  it("a comment mentioning admin/owner and first user", () => {
    const src = [
      `// The first user used to become admin here; now roles come from invites.`,
      `/* UPDATE users SET role = 'admin' WHERE count(*) = 0 */`,
      `export const x = 1;`,
    ].join("\n");
    expect(scan("lib/x.ts", src)).toEqual([]);
  });

  it("SELECT role FROM users and a WHERE role filter", () => {
    const src = [
      `const r = await query("SELECT role FROM users WHERE id = $1", [id]);`,
      `const admins = await query("SELECT count(*) FROM users WHERE role = 'admin'");`,
      `const n = await query("SELECT id FROM users u WHERE u.role = 'admin'");`,
    ].join("\n");
    expect(scan("app/admin/page.tsx", src)).toEqual([]);
  });

  it("an admin page using requireAdminPage", () => {
    const src = [
      `import { requireAdminPage } from "@/lib/auth";`,
      `import { query } from "@/lib/db";`,
      `export default async function Kitchen() {`,
      `  const admin = await requireAdminPage();`,
      `  const { rows } = await query("SELECT id, email, role FROM users ORDER BY id");`,
      `  if (rows.length === 0) return <p>No users yet</p>;`,
      `  return <ul>{rows.map((u) => <li key={u.id}>{u.email} {u.role}</li>)}</ul>;`,
      `}`,
    ].join("\n");
    expect(scan("app/kitchen/page.tsx", src)).toEqual([]);
  });

  it("a seed script comment and non-privileged app data", () => {
    const src = [
      `// seed: do NOT create an admin here, the founder invites themselves from Zavi`,
      `await c.query("INSERT INTO posts (title, owner_id) VALUES ($1, $2)", [t, uid]);`,
      `await c.query("UPDATE projects SET owner = $1 WHERE id = $2", [uid, pid]);`,
      `await db.insert(teamMembers).values({ teamId, userId: me.id, role: "member" });`,
      `const url = "https://example.com//path"; // not a comment start inside the string`,
    ].join("\n");
    expect(scan("scripts/seed.mjs", src)).toEqual([]);
  });

  it("ORM / JS read filters on role (an admin page listing admins)", () => {
    const src = [
      `const admins = await prisma.user.findMany({ where: { role: "admin" } });`,
      `const first = await prisma.user.findFirst({ where: { role: 'owner', active: true } });`,
      `const adminCount = await prisma.user.count({ where: { role: 'admin' } });`,
      `if (adminCount === 0) return <p>No admins yet</p>;`,
      `const n = await count({ where: { role: 'admin' } });`,
      `const rows = await db.select().from(users).where(eq(users.role, "admin"));`,
      `const list = users.filter((u) => u.role === "admin");`,
      `const some = users.some((u) => u.role !== "admin");`,
      `const k = await knex("users").where({ role: "admin" }).select("id");`,
      `const m = await User.countDocuments({ role: "admin" });`,
      `const nested = await prisma.user.findMany({`,
      `  where: {`,
      `    AND: [{ role: "admin" }, { active: true }],`,
      `  },`,
      `});`,
      `await prisma.user.updateMany({ where: { role: "admin" }, data: { active: false } });`,
    ].join("\n");
    expect(scan("app/admin/users/page.tsx", src)).toEqual([]);
  });

  it("a TS union type naming the roles", () => {
    expect(scan("lib/types.ts", `export type U = { role: "admin" | "user" };`)).toEqual([]);
  });

  it("ignores deleted, binary, non-code and test files", () => {
    const bad = `await query("UPDATE users SET role = 'admin'");`;
    expect(
      detectUnsafeRoleGrant([
        { path: "lib/a.ts", action: "delete", content: bad },
        { path: "lib/b.ts", encoding: "base64", content: bad },
        { path: "README.md", content: bad },
        { path: "lib/__tests__/a.test.ts", content: bad },
        { path: "lib/a.spec.ts", content: bad },
      ]),
    ).toEqual([]);
  });
});

describe("formatRoleGrantError", () => {
  it("names file:line, the rule and the fix, capped at 5 hits", () => {
    const hits = Array.from({ length: 7 }, (_, i) => ({ file: "app/x.ts", line: i + 1, rule: "sql_role_write" as const }));
    const msg = formatRoleGrantError(hits);
    expect(msg).toMatch(/^unsafe_role_grant: app\/x\.ts:1 SQL write sets a role/);
    expect(msg).toContain("app/x.ts:5");
    expect(msg).not.toContain("app/x.ts:6");
    expect(msg).toContain("(+2 more)");
    expect(msg).toContain("requireAdminPage/requireAdminRoute/requireAdminAction");
    expect(msg).toMatch(/never by signup order, first user, row count, email or env/);
  });
});

describe("find* methods that WRITE are not read filters (re-review 2026-09-27)", () => {
  const grants = [
    `await User.findOrCreate({ where: { email }, defaults: { role: "admin" } });`,
    `await User.findOneAndUpdate({ email }, { role: "admin" });`,
    `await User.findByIdAndUpdate(id, { $set: { role: "admin" } });`,
    `await Users.findOneAndReplace({ email }, { email, role: "admin" });`,
    `await users.insertOne({ email, role: "admin" });`,
  ];
  for (const code of grants) {
    it(`flags: ${code}`, () => {
      expect(detectUnsafeRoleGrant([{ path: "app/api/signup/route.ts", content: code }]).length).toBeGreaterThan(0);
    });
  }
  const reads = [
    `const admins = await prisma.user.findMany({ where: { role: "admin" } });`,
    `const a = await User.findOne({ role: "admin" });`,
  ];
  for (const code of reads) {
    it(`does not flag read: ${code}`, () => {
      expect(detectUnsafeRoleGrant([{ path: "app/admin/page.tsx", content: code }])).toEqual([]);
    });
  }
});
