function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "object": return record(value);
    case "array": return Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

export function composioSchemaError(value: unknown, schema: unknown, path = "arguments"): string | null {
  if (!record(schema)) return null;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(value, type))) return `${path} has wrong type (expected ${JSON.stringify(schema.type)}).`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}.`;
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    return `${path} requires at least ${schema.minLength} character(s).`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} requires at least ${schema.minItems} item(s).`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} item(s).`;
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path} requires unique items.`;
    for (let i = 0; i < value.length; i++) {
      const error = composioSchemaError(value[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  if (record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && (!Object.hasOwn(value, key) || value[key] === undefined)) return `${path}.${key} is required.`;
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(properties, key)) return `${path}.${key} is not allowed.`;
      const error = composioSchemaError(item, properties[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}
