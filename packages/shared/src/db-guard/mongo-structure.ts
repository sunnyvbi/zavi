
export const MONGO_STRUCTURE_SAMPLE = 200;
export const MONGO_STRUCTURE_MAX_FIELDS = 500;
export const MONGO_STRUCTURE_MAX_NESTED = 20;
export const MONGO_NESTED_OVERSAMPLE = 5;

export function mongoStructurePipeline(opts: { sampleSize?: number; nestedKey?: string } = {}): Record<string, unknown>[] {
  const size = opts.sampleSize ?? MONGO_STRUCTURE_SAMPLE;
  const pre: Record<string, unknown>[] = opts.nestedKey
    ? [{ $sample: { size: size * MONGO_NESTED_OVERSAMPLE } }, { $match: { [opts.nestedKey]: { $type: "object" } } }, { $limit: size }]
    : [{ $sample: { size } }];
  return [
    ...pre,
    { $project: { _id: 0, kv: { $objectToArray: opts.nestedKey ? `$${opts.nestedKey}` : "$$ROOT" } } },
    { $unwind: "$kv" },
    { $group: { _id: "$kv.k", types: { $addToSet: { $type: "$kv.v" } }, n: { $sum: 1 } } },
    { $limit: MONGO_STRUCTURE_MAX_FIELDS },
  ];
}

const TYPE_NAMES: Record<string, string> = {
  double: "Double", int: "Int32", long: "Long", decimal: "Decimal128", string: "String", object: "Document",
  array: "Array", binData: "Binary", objectId: "ObjectId", bool: "Boolean", date: "Date", null: "Null",
  regex: "RegExp", timestamp: "Timestamp", javascript: "Code", symbol: "Symbol", undefined: "Undefined",
  minKey: "MinKey", maxKey: "MaxKey",
};

export type MongoStructureRow = { _id: unknown; types?: unknown; n?: unknown };
export type MongoStructureColumn = { name: string; type: string; nullable: boolean; rawTypes: string[] };

export function mongoStructureColumns(rows: MongoStructureRow[], prefix = ""): MongoStructureColumn[] {
  const clean = rows
    .filter((r) => typeof r._id === "string" && r._id.length > 0 && r._id.length <= 256)
    .map((r) => ({
      name: r._id as string,
      rawTypes: (Array.isArray(r.types) ? r.types : []).filter((t): t is string => typeof t === "string" && t in TYPE_NAMES),
      n: typeof r.n === "number" && Number.isFinite(r.n) ? r.n : 0,
    }));
  const total = Math.max(0, ...clean.map((c) => c.n));
  return clean.map((c) => {
    const named = c.rawTypes.filter((t) => t !== "undefined").map((t) => TYPE_NAMES[t]!);
    return {
      name: prefix ? `${prefix}.${c.name}` : c.name,
      type: named.filter((t) => t !== "Null").join("|") || (named.includes("Null") ? "Null" : "Mixed"),
      nullable: c.n < total || c.rawTypes.includes("null"),
      rawTypes: c.rawTypes,
    };
  });
}

export function isMongoTimeout(e: unknown): boolean {
  const err = e as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  return !!err && (err.code === 50 || err.codeName === "MaxTimeMSExpired" || /exceeded time limit/i.test(String(err.message ?? "")));
}

export async function readMongoStructure(
  collection: { aggregate(pipeline: Record<string, unknown>[], opts: { maxTimeMS: number }): { toArray(): Promise<unknown[]> } },
  pipeline: Record<string, unknown>[],
  maxTimeMS = 5000,
): Promise<MongoStructureRow[] | null> {
  try {
    return (await collection.aggregate(pipeline, { maxTimeMS }).toArray()) as MongoStructureRow[];
  } catch (e) {
    if (isMongoTimeout(e)) return null;
    throw e;
  }
}
