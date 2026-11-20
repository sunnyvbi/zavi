
const BANNED_WITH_HINT = [
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
] as const;

const BANNED_NO_HINT = [
  "format",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "default",
] as const;

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hintFor(keyword: string, value: unknown): string | null {
  switch (keyword) {
    case "minLength":
      return `min ${value} chars`;
    case "maxLength":
      return `max ${value} chars`;
    case "pattern":
      return `pattern ${String(value)}`;
    case "minimum":
      return `min ${value}`;
    case "maximum":
      return `max ${value}`;
    case "minItems":
      return `min ${value} items`;
    case "maxItems":
      return `max ${value} items`;
    default:
      return null;
  }
}

function stripBannedKeywords(node: JsonObject): void {
  const hints: string[] = [];
  for (const kw of BANNED_WITH_HINT) {
    if (kw in node) {
      const h = hintFor(kw, node[kw]);
      if (h) hints.push(h);
      delete node[kw];
    }
  }
  for (const kw of BANNED_NO_HINT) {
    if (kw in node) delete node[kw];
  }
  if (hints.length > 0) {
    const note = ` (${hints.join("; ")})`;
    const existing = typeof node.description === "string" ? node.description : "";
    if (!existing.endsWith(note)) {
      node.description = existing ? existing + note : note.trimStart();
    }
  }
}

function makeNullable(node: JsonObject): void {
  if ("const" in node) {
    node.enum = [node.const];
    delete node.const;
  }
  if (Array.isArray(node.enum) && !node.enum.includes(null)) {
    node.enum = [...node.enum, null];
  }
  if (typeof node.type === "string") {
    if (node.type !== "null") node.type = [node.type, "null"];
    return;
  }
  if (Array.isArray(node.type)) {
    if (!node.type.includes("null")) node.type = [...node.type, "null"];
    return;
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(node[key])) {
      const branches = node[key] as unknown[];
      const hasNull = branches.some(
        (b) => isPlainObject(b) && b.type === "null",
      );
      if (!hasNull) node[key] = [...branches, { type: "null" }];
      return;
    }
  }
  if (Array.isArray(node.enum)) {
    return;
  }
  if (Object.keys(node).every((k) => k === "description" || k === "title")) {
    node.type = ["string", "null"];
    const hint = "Pass structured data (objects, arrays) as a JSON string.";
    node.description = typeof node.description === "string" && node.description ? `${node.description} ${hint}` : hint;
    return;
  }
  node.anyOf = [{ ...node }, { type: "null" }];
  for (const k of Object.keys(node)) {
    if (k !== "anyOf" && k !== "description") delete node[k];
  }
}

export function toOpenAiStrictSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;

  const node: JsonObject = { ...schema };

  stripBannedKeywords(node);

  if (node.type === undefined && node.anyOf === undefined && node.$ref === undefined) {
    const vals = "const" in node ? [node.const] : Array.isArray(node.enum) ? (node.enum as unknown[]) : null;
    if (vals && vals.length > 0) {
      const kinds = [...new Set(vals.map((v) => (v === null ? "null" : typeof v === "number" ? "number" : typeof v)))];
      if (kinds.every((k) => k === "string" || k === "number" || k === "boolean" || k === "null")) {
        node.type = kinds.length === 1 ? kinds[0] : kinds;
      }
    }
  }

  if (isPlainObject(node.properties)) {
    const props = node.properties as JsonObject;
    const prevRequired = new Set(
      Array.isArray(node.required)
        ? (node.required as unknown[]).filter(
            (r): r is string => typeof r === "string",
          )
        : [],
    );
    const normalizedProps: JsonObject = {};
    const allKeys: string[] = [];
    for (const [key, value] of Object.entries(props)) {
      allKeys.push(key);
      const normalizedChild = toOpenAiStrictSchema(value);
      if (!prevRequired.has(key) && isPlainObject(normalizedChild)) {
        const childCopy: JsonObject = { ...normalizedChild };
        makeNullable(childCopy);
        normalizedProps[key] = childCopy;
      } else {
        normalizedProps[key] = normalizedChild;
      }
    }
    node.properties = normalizedProps;
    node.required = allKeys;
    node.additionalProperties = false;
  } else if (node.type === "object") {
    node.additionalProperties = false;
  }

  if (Array.isArray(node.items)) {
    node.items = (node.items as unknown[]).map((it) => toOpenAiStrictSchema(it));
  } else if (node.items !== undefined) {
    node.items = toOpenAiStrictSchema(node.items);
  }

  if (node.additionalItems !== undefined) {
    node.additionalItems = toOpenAiStrictSchema(node.additionalItems);
  }
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems = (node.prefixItems as unknown[]).map((it) =>
      toOpenAiStrictSchema(it),
    );
  }

  for (const comb of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[comb])) {
      node[comb] = (node[comb] as unknown[]).map((s) =>
        toOpenAiStrictSchema(s),
      );
    }
  }

  if (Array.isArray(node.oneOf) && node.anyOf === undefined) {
    node.anyOf = node.oneOf;
    delete node.oneOf;
  }
  if (Array.isArray(node.anyOf) && !isPlainObject(node.properties)) {
    delete node.type;
    delete node.additionalProperties;
    delete node.required;
  }

  for (const defsKey of ["$defs", "definitions"] as const) {
    if (isPlainObject(node[defsKey])) {
      const defs = node[defsKey] as JsonObject;
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(defs)) {
        out[k] = toOpenAiStrictSchema(v);
      }
      node[defsKey] = out;
    }
  }

  return node;
}

export function isStrictExpressible(schema: unknown): boolean {
  function walk(node: unknown): boolean {
    if (Array.isArray(node)) return node.every(walk);
    if (!isPlainObject(node)) return true;
    const hasProps =
      isPlainObject(node.properties) &&
      Object.keys(node.properties as JsonObject).length > 0;
    if (isPlainObject(node.additionalProperties) && !hasProps) return false;
    if (node.patternProperties !== undefined || node.propertyNames !== undefined) {
      return false;
    }
    for (const v of Object.values(node)) {
      if (!walk(v)) return false;
    }
    return true;
  }
  return walk(schema);
}

export function stripNullsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => v !== null)
      .map((v) => stripNullsDeep(v));
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNullsDeep(v);
    }
    return out;
  }
  return value;
}

function resolveSchemaRef(node: unknown, root: unknown, depth = 0): unknown {
  if (depth > 8 || !isPlainObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isPlainObject(cur)) return node;
    cur = (cur as JsonObject)[decodeURIComponent(part)];
  }
  return resolveSchemaRef(cur, root, depth + 1);
}

export function reconcileOpenAiStrictToolInput(
  input: unknown,
  schema: unknown,
  root?: unknown,
): unknown {
  const rootSchema = root ?? schema;
  const node = resolveSchemaRef(schema, rootSchema);

  if (Array.isArray(input)) {
    const itemsSchema = isPlainObject(node) ? node.items : undefined;
    return input.map((el, i) =>
      reconcileOpenAiStrictToolInput(
        el,
        Array.isArray(itemsSchema) ? itemsSchema[i] : itemsSchema,
        rootSchema,
      ),
    );
  }

  if (isPlainObject(input)) {
    if (!isPlainObject(node) || !isPlainObject(node.properties)) {
      return stripNullsDeep(input);
    }
    const props = node.properties as JsonObject;
    const required = new Set(
      Array.isArray(node.required)
        ? (node.required as unknown[]).filter((k): k is string => typeof k === "string")
        : [],
    );
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === null && !required.has(k)) continue;
      out[k] = reconcileOpenAiStrictToolInput(v, props[k], rootSchema);
    }
    return out;
  }

  return input;
}
