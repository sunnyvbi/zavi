import { describe, it, expect } from "vitest";
import {
  validateManifest, diffManifest, shardCollectionRow, forbiddenSitePaths, canonicalPrincipals, sha256Hex,
  type Manifest,
} from "../manifest";
import { TEMPLATE_FILES } from "../template-files.generated";

const base = () => ({
  schemaVersion: 1,
  collections: {
    posts: {
      rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], update: ["owner", "admin"], delete: ["admin"] },
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", maxLength: 120 },
          status: { type: "string", maxLength: 10, enum: ["draft", "live"] },
          price: { type: "number", minimum: 0 },
          when: { type: "string", maxLength: 40, format: "date-time" },
          tags: { type: "array", maxItems: 5, items: { type: "string", maxLength: 20 } },
          secret: { type: "string", maxLength: 50 },
        },
      },
      fields: { secret: { read: ["admin"], write: ["admin"] } },
      indexes: { status: { type: "text", ops: ["eq"], sort: false } },
    },
  },
});

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function withPosts(mut: (c: AnyObj) => void): AnyObj {
  const m = base() as AnyObj;
  mut(m.collections.posts);
  return m;
}
function codes(input: unknown): string[] {
  const r = validateManifest(input);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

describe("validateManifest: accepts", () => {
  it("the starter's own zavi-site.json", () => {
    const r = validateManifest(TEMPLATE_FILES["zavi-site.json"]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a full records collection and a files area, as JSON text or a value", () => {
    const m = base() as AnyObj;
    m.collections.photos = { kind: "files", rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], delete: ["owner"] } };
    expect(validateManifest(m).ok).toBe(true);
    expect(validateManifest(JSON.stringify(m)).ok).toBe(true);
  });

  it("returns a canonical value: all five ops, ordered deduped principals, defaults filled", () => {
    const r = validateManifest(withPosts((c) => {
      c.rules = { update: ["admin", "owner", "admin"], list: ["role:zeta", "anyone", "role:alpha"] };
      delete c.fields;
      delete c.indexes;
    }));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const p = r.value.collections.posts;
    expect(p.rules).toEqual({ list: ["anyone", "role:alpha", "role:zeta"], get: [], create: [], update: ["owner", "admin"], delete: [] });
    expect(p.fields).toEqual({});
    expect(p.indexes).toEqual({});
    expect(p.kind).toBe("records");
    if (p.kind === "records") expect(p.schema.required).toEqual(["title"]);
  });

  it("hash is over the canonical form: key order, principal order and duplicates do not change it", () => {
    const a = validateManifest(base());
    const shuffled = JSON.parse(JSON.stringify(base()));
    shuffled.collections.posts.rules.update = ["admin", "owner", "owner"];
    const reordered = JSON.parse(JSON.stringify({ collections: shuffled.collections, schemaVersion: 1 }));
    const b = validateManifest(reordered);
    if (!a.ok || !b.ok) throw new Error("expected valid");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    const c = validateManifest(withPosts((x) => { x.rules.delete = ["owner"]; }));
    if (!c.ok) throw new Error("expected valid");
    expect(c.hash).not.toBe(a.hash);
  });

  it("sha256 matches the known vectors (the hash must agree in browser, Node and Worker)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("é😀")).toBe(require("node:crypto").createHash("sha256").update("é😀").digest("hex"));
    const long = "x".repeat(1000);
    expect(sha256Hex(long)).toBe(require("node:crypto").createHash("sha256").update(long).digest("hex"));
  });

  it("field and collection names like constructor/toString are ordinary names", () => {
    const m = { schemaVersion: 1, collections: { constructor: { rules: { list: ["anyone"] }, schema: { type: "object", properties: { tostring: { type: "boolean" }, constructor: { type: "boolean" } } } } } };
    expect(validateManifest(m).ok).toBe(true);
  });
});

describe("validateManifest: rejects (malicious and mistaken manifests)", () => {
  it.each([
    ["anyone on update", (c: AnyObj) => { c.rules.update = ["anyone"]; }, "anyone_not_allowed"],
    ["anyone on delete", (c: AnyObj) => { c.rules.delete = ["admin", "anyone"]; }, "anyone_not_allowed"],
    ["unknown principal", (c: AnyObj) => { c.rules.list = ["everyone"]; }, "unknown_principal"],
    ["SQL in a role principal", (c: AnyObj) => { c.rules.get = ["role:admin' or '1'='1"]; }, "unknown_principal"],
    ["uppercase role", (c: AnyObj) => { c.rules.get = ["role:Admin"]; }, "unknown_principal"],
    ["role name too long", (c: AnyObj) => { c.rules.get = [`role:${"a".repeat(33)}`]; }, "unknown_principal"],
    ["principal that is not a string", (c: AnyObj) => { c.rules.get = [{ or: "admin" }]; }, "invalid_principal"],
    ["principals not an array", (c: AnyObj) => { c.rules.get = "anyone"; }, "invalid_principals"],
    ["more than 8 principals", (c: AnyObj) => { c.rules.get = Array.from({ length: 9 }, (_, i) => `role:r${i}`); }, "too_many_principals"],
    ["unknown op", (c: AnyObj) => { c.rules.read = ["anyone"]; }, "unknown_op"],
    ["no rules at all", (c: AnyObj) => { delete c.rules; }, "missing_rules"],
    ["anyone in a write mask on update is fine but an unknown principal is not", (c: AnyObj) => { c.fields.secret.write = ["root"]; }, "unknown_principal"],
    ["mask on an undeclared field", (c: AnyObj) => { c.fields.ghost = { read: ["admin"] }; }, "undeclared_field"],
    ["mask with an unknown key", (c: AnyObj) => { c.fields.secret = { read: ["admin"], delete: ["admin"] }; }, "invalid_mask"],
    ["string without maxLength (SQL lets it through: unbounded)", (c: AnyObj) => { delete c.schema.properties.title.maxLength; }, "unbounded_string"],
    ["fractional maxLength", (c: AnyObj) => { c.schema.properties.title.maxLength = 10.5; }, "unbounded_string"],
    ["maxLength over 10000", (c: AnyObj) => { c.schema.properties.title.maxLength = 10001; }, "unbounded_string"],
    ["array without maxItems", (c: AnyObj) => { delete c.schema.properties.tags.maxItems; }, "unbounded_array"],
    ["array item string without maxLength", (c: AnyObj) => { delete c.schema.properties.tags.items.maxLength; }, "unbounded_string"],
    ["nested object", (c: AnyObj) => { c.schema.properties.addr = { type: "object" }; }, "invalid_type"],
    ["array of arrays", (c: AnyObj) => { c.schema.properties.grid = { type: "array", maxItems: 2, items: { type: "array", maxItems: 2, items: { type: "boolean" } } }; }, "invalid_type"],
    ["unsupported JSON-schema keyword (pattern = ReDoS surface)", (c: AnyObj) => { c.schema.properties.title.pattern = "(a+)+$"; }, "unsupported_keyword"],
    ["$ref", (c: AnyObj) => { c.schema.properties.title = { $ref: "#/x" }; }, "unsupported_keyword"],
    ["additionalProperties at schema level", (c: AnyObj) => { c.schema.additionalProperties = true; }, "unsupported_keyword"],
    ["reserved field owner_id", (c: AnyObj) => { c.schema.properties.owner_id = { type: "string", maxLength: 36 }; }, "reserved_field"],
    ["reserved field id", (c: AnyObj) => { c.schema.properties.id = { type: "string", maxLength: 36 }; }, "reserved_field"],
    ["reserved field mine", (c: AnyObj) => { c.schema.properties.mine = { type: "boolean" }; }, "reserved_field"],
    ["__proto__ field", (c: AnyObj) => { c.schema.properties = JSON.parse('{"__proto__": {"type":"boolean"}, "title": {"type":"string","maxLength":5}}'); }, "invalid_field_name"],
    ["required names an undeclared field", (c: AnyObj) => { c.schema.required = ["title", "ghost"]; }, "undeclared_field"],
    ["format null", (c: AnyObj) => { c.schema.properties.title.format = null; }, "invalid_format"],
    ["unknown format", (c: AnyObj) => { c.schema.properties.title.format = "url"; }, "invalid_format"],
    ["enum of numbers", (c: AnyObj) => { c.schema.properties.status.enum = [1, 2]; }, "invalid_value"],
    ["minimum above maximum", (c: AnyObj) => { c.schema.properties.price = { type: "number", minimum: 5, maximum: 1 }; }, "invalid_value"],
    ["boolean with extra keyword", (c: AnyObj) => { c.schema.properties.flag = { type: "boolean", maxLength: 1 }; }, "keyword_not_allowed"],
    ["more than 3 text indexes", (c: AnyObj) => {
      c.schema.properties.slug = { type: "string", maxLength: 40 };
      c.indexes = {
        status: { type: "text", ops: ["eq"] }, title: { type: "text", ops: ["eq"] },
        secret: { type: "text", ops: ["eq"] }, slug: { type: "text", ops: ["eq"] },
      };
    }, "index_budget"],
    ["more than 2 number indexes", (c: AnyObj) => {
      c.schema.properties.qty = { type: "integer" };
      c.schema.properties.rank = { type: "number" };
      c.indexes = { price: { type: "number", ops: ["eq"] }, qty: { type: "number", ops: ["eq"] }, rank: { type: "number", ops: ["range"] } };
    }, "index_budget"],
    ["text index on a long string (btree entry size)", (c: AnyObj) => {
      c.schema.properties.title.maxLength = 1000;
      c.indexes = { title: { type: "text", ops: ["eq"] } };
    }, "index_type_mismatch"],
    ["text index on a date string", (c: AnyObj) => { c.indexes = { when: { type: "text", ops: ["eq"] } }; }, "index_type_mismatch"],
    ["prefix on a number index", (c: AnyObj) => { c.indexes = { price: { type: "number", ops: ["prefix"] } }; }, "invalid_index_op"],
    ["index on an undeclared field", (c: AnyObj) => { c.indexes = { ghost: { type: "text", ops: ["eq"] } }; }, "undeclared_field"],
    ["slice-1 slot syntax", (c: AnyObj) => { c.indexes = { status: "s1" }; }, "invalid_index"],
    ["number index on a string", (c: AnyObj) => { c.indexes = { title: { type: "number", ops: ["eq"] } }; }, "index_type_mismatch"],
    ["timestamp index on a plain string", (c: AnyObj) => { c.indexes = { title: { type: "timestamp", ops: ["gt"] } }; }, "index_type_mismatch"],
    ["text index on an array", (c: AnyObj) => { c.indexes = { tags: { type: "text", ops: ["eq"] } }; }, "index_type_mismatch"],
    ["gt is a filter, not a declared op (declare range)", (c: AnyObj) => { c.indexes = { status: { type: "text", ops: ["gt"] } }; }, "invalid_index_op"],
    ["duplicate op", (c: AnyObj) => { c.indexes = { status: { type: "text", ops: ["eq", "eq"] } }; }, "invalid_index_op"],
    ["empty ops", (c: AnyObj) => { c.indexes = { status: { type: "text", ops: [] } }; }, "invalid_index"],
    ["sort not a boolean", (c: AnyObj) => { c.indexes = { status: { type: "text", ops: ["eq"], sort: "yes" } }; }, "invalid_index"],
    ["unknown collection key (e.g. raw sql)", (c: AnyObj) => { c.sql = "drop table zsite.records"; }, "unknown_key"],
    ["files kind cannot carry a schema", (c: AnyObj) => { c.kind = "files"; }, "files_area_shape"],
    ["bad kind", (c: AnyObj) => { c.kind = "table"; }, "invalid_kind"],
  ])("%s", (_name, mut, code) => {
    expect(codes(withPosts(mut))).toContain(code);
  });

  it("a date field indexed as text is told to use a timestamp index, so the builder fixes it in one pass", () => {
    const r = validateManifest(withPosts((c: AnyObj) => { c.indexes = { when: { type: "text", ops: ["eq"] } }; }));
    expect(r.ok).toBe(false);
    const issue = (r as { issues: Array<{ path: string; message: string }> }).issues.find((i) => i.path.endsWith("indexes.when.type"));
    expect(issue?.message).toBe('"when" is a date: index it as {"type": "timestamp"}, not "text"');
  });

  it("a files area whose list and get differ (storage list and download are one SELECT)", () => {
    const m = { schemaVersion: 1, collections: { photos: { kind: "files", rules: { list: ["admin"], get: ["anyone"] } } } };
    expect(codes(m)).toContain("files_area_shape");
    const ok = { schemaVersion: 1, collections: { photos: { kind: "files", rules: { list: ["owner", "admin"], get: ["admin", "owner"] } } } };
    expect(validateManifest(ok).ok).toBe(true);
  });

  it.each([
    ["Messages"], ["1st"], ["drop table x;--"], ["a".repeat(64)], ["with-dash"], [""],
  ])("collection name %j", (name) => {
    const m = { schemaVersion: 1, collections: { [name]: base().collections.posts } };
    expect(codes(m)).toContain("invalid_name");
  });

  it("top level: schemaVersion required, unknown keys refused, not an object, bad JSON, too many collections", () => {
    const noVersion = base() as AnyObj;
    delete noVersion.schemaVersion;
    expect(codes(noVersion)).toContain("unsupported_schema_version");
    expect(codes({ ...base(), schemaVersion: 3 })).toContain("unsupported_schema_version");
    expect(codes({ ...base(), migrations: ["001.sql"] })).toContain("unknown_key");
    expect(codes([])).toContain("invalid_manifest");
    expect(codes("{not json")).toContain("invalid_json");
    const many: AnyObj = { schemaVersion: 1, collections: {} };
    for (let i = 0; i < 65; i++) many.collections[`c${i}`] = base().collections.posts;
    expect(codes(many)).toContain("too_many_collections");
  });

  it("reports every problem with a path, not just the first", () => {
    const r = validateManifest(withPosts((c) => { c.rules.update = ["anyone"]; delete c.schema.properties.title.maxLength; }));
    if (r.ok) throw new Error("expected invalid");
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["collections.posts.rules.update[0]", "collections.posts.schema.properties.title.maxLength"]));
  });
});

describe("canonicalPrincipals", () => {
  it("orders anyone, signed_in, owner, admin, then roles A-Z, deduped", () => {
    expect(canonicalPrincipals(["role:b", "admin", "anyone", "role:a", "owner", "signed_in", "admin"]))
      .toEqual(["anyone", "signed_in", "owner", "admin", "role:a", "role:b"]);
  });
});

function canon(m: unknown): Manifest {
  const r = validateManifest(m);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe("diffManifest", () => {
  it("first deploy: every collection is added", () => {
    expect(diffManifest(null, canon(base()))).toEqual([{ type: "collection_added", collection: "posts", kind: "records", breaking: false }]);
  });

  it("no change, no diff", () => {
    expect(diffManifest(canon(base()), canon(base()))).toEqual([]);
  });

  it("describes rules, fields, required, masks and indexes, flagging what can break existing data", () => {
    const next = withPosts((c) => {
      c.rules.delete = ["owner", "admin"];
      c.schema.properties.title.maxLength = 60;
      delete c.schema.properties.tags;
      c.schema.properties.slug = { type: "string", maxLength: 40 };
      c.schema.required = ["title", "price"];
      c.fields = {};
      c.indexes = { price: { type: "number", ops: ["range"], sort: true } };
    });
    const d = diffManifest(canon(base()), canon(next));
    const t = (type: string) => d.filter((x) => x.type === type);
    expect(t("rules_changed")).toEqual([{ type: "rules_changed", collection: "posts", op: "delete", from: ["admin"], to: ["owner", "admin"], breaking: false }]);
    expect(t("field_changed")[0]).toMatchObject({ field: "title", breaking: true });
    expect(t("field_removed")[0]).toMatchObject({ field: "tags", breaking: true });
    expect(t("field_added")[0]).toMatchObject({ field: "slug", required: false, breaking: false });
    expect(t("required_changed")[0]).toMatchObject({ added: ["price"], removed: [], breaking: true });
    expect(t("mask_changed")[0]).toMatchObject({ field: "secret", to: null });
    expect(t("index_removed")[0]).toMatchObject({ field: "status" });
    expect(t("index_added")[0]).toMatchObject({ field: "price", breaking: true });
  });

  it("removing a collection or changing its kind is breaking", () => {
    const files = { schemaVersion: 1, collections: { posts: { kind: "files", rules: {} } } };
    expect(diffManifest(canon(base()), canon(files))).toEqual([{ type: "kind_changed", collection: "posts", from: "records", to: "files", breaking: true }]);
    expect(diffManifest(canon(base()), canon({ schemaVersion: 1, collections: {} }))).toEqual([{ type: "collection_removed", collection: "posts", kind: "records", breaking: true }]);
  });
});

describe("shardCollectionRow", () => {
  it("is the canonical collection, typed indexes included (the shard assigns slot columns)", () => {
    const m = canon(withPosts((c) => {
      c.indexes = { price: { type: "number", ops: ["range", "eq"], sort: true }, when: { type: "timestamp", ops: ["range"] }, status: { type: "text", ops: ["prefix", "in", "eq"] } };
    }));
    const row = shardCollectionRow("posts", m.collections.posts);
    expect(row.indexes).toEqual({
      price: { type: "number", ops: ["eq", "range"], sort: true },
      when: { type: "timestamp", ops: ["range"], sort: false },
      status: { type: "text", ops: ["eq", "in", "prefix"], sort: false },
    });
    expect(row.rules.update).toEqual(["owner", "admin"]);
    expect(row.kind).toBe("records");
  });

  it("accepts the full slot budget: 3 text, 2 number, 2 timestamp", () => {
    const m = withPosts((c) => {
      Object.assign(c.schema.properties, { a: { type: "integer" }, b: { type: "string", maxLength: 10, format: "date" } });
      c.indexes = {
        title: { type: "text", ops: ["eq"] }, status: { type: "text", ops: ["eq"] }, secret: { type: "text", ops: ["eq"] },
        price: { type: "number", ops: ["range"] }, a: { type: "number", ops: ["eq"] },
        when: { type: "timestamp", ops: ["range"], sort: true }, b: { type: "timestamp", ops: ["eq"] },
      };
    });
    expect(validateManifest(m).ok).toBe(true);
  });
});

describe("forbiddenSitePaths", () => {
  it("flags any supabase/ path and any .sql file", () => {
    expect(forbiddenSitePaths(["src/App.tsx", "supabase/migrations/001_x.sql", "db/seed.SQL", "./supabase", "zavi-site.json"]))
      .toEqual(["supabase/migrations/001_x.sql", "db/seed.SQL", "./supabase"]);
  });
});
