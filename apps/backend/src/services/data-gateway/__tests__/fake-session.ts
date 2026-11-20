import type { ReadSession, MongoFacade, DynamoFacade } from "../session";

export type FakeCalls = { sql: { text: string; params?: unknown[] }[]; mongo: { op: string; args: unknown[] }[] };

export function fakeSession(opts: {
  dialect: ReadSession["dialect"];
  rows?: Record<string, unknown>[];
  docs?: Record<string, unknown>[];
  fail?: Error;
}): { session: ReadSession; calls: FakeCalls } {
  const calls: FakeCalls = { sql: [], mongo: [] };
  const rec = (op: string) => async (...args: unknown[]) => {
    calls.mongo.push({ op, args });
    if (opts.fail) throw opts.fail;
    if (op === "countDocuments" || op === "estimatedDocumentCount") return 3;
    if (op === "findOne") return opts.docs?.[0] ?? null;
    if (op === "listCollections") return (opts.docs ?? []) as never;
    return (opts.docs ?? []).map((d) => ({ ...d }));
  };
  const mongo = {
    database: { name: "app", explicit: true },
    find: rec("find"),
    findOne: rec("findOne"),
    aggregate: rec("aggregate"),
    countDocuments: rec("countDocuments"),
    estimatedDocumentCount: rec("estimatedDocumentCount"),
    listCollections: rec("listCollections"),
  } as unknown as MongoFacade;
  const session: ReadSession = {
    dialect: opts.dialect,
    async query(text, params) {
      calls.sql.push({ text, params });
      if (opts.fail) throw opts.fail;
      const rows = (opts.rows ?? []).map((r) => ({ ...r }));
      return { rows, fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })), truncated: false };
    },
    mongo: () => mongo,
    dynamo: () => ({ scan: async () => [], query: async () => [] }) as DynamoFacade,
    sessionTimeZone: () => undefined,
    largestTableRows: async () => null,
    close: async () => undefined,
  };
  return { session, calls };
}
