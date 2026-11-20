
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  type ListTablesCommandOutput,
} from "@aws-sdk/client-dynamodb";
import type { RawColumn, RawIntrospection, RawTable } from "@/services/tools/operator-db/types";
import {
  DEFAULT_TABLE_CAP,
  isSafeName,
  prioritizeAndCap,
} from "@/services/tools/operator-db/discovery/util";
import { parseDynamodbUri } from "@/services/tools/operator-db/dynamodb-uri";
import { makeDynamoClient } from "../direct/dynamo";

function ddbTypeString(scalarType: string | undefined): string {
  switch (scalarType) {
    case "S":
      return "string";
    case "N":
      return "number";
    case "B":
      return "binary";
    default:
      return "Mixed";
  }
}

export async function introspectDynamodb(
  connectionString: string,
  tableCap: number = DEFAULT_TABLE_CAP,
  deadlineMs: number = Date.now() + 25_000,
): Promise<RawIntrospection> {
  const parsed = parseDynamodbUri(connectionString);
  const low: DynamoDBClient = makeDynamoClient(parsed);
  try {
    const allNames: string[] = [];
    let last: string | undefined = undefined;
    let listingTruncated = false;
    let listingTimedOut = false;
    do {
      if (Date.now() > deadlineMs) {
        listingTruncated = true;
        listingTimedOut = true;
        break;
      }
      const out: ListTablesCommandOutput = await low.send(
        new ListTablesCommand({ ExclusiveStartTableName: last, Limit: 100 }),
      );
      for (const n of out.TableNames ?? []) allNames.push(n);
      last = out.LastEvaluatedTableName;
      if (allNames.length >= tableCap * 4) {
        listingTruncated = true;
        break;
      }
    } while (last);

    const skippedUnsafeNames = allNames.filter((n) => !isSafeName(n)).length;
    const picked = prioritizeAndCap(allNames, tableCap);

    let deadlineHit = listingTimedOut;
    const tables: RawTable[] = [];
    for (const t of picked) {
      if (Date.now() > deadlineMs) {
        deadlineHit = true;
        break;
      }
      let keyColumns: RawColumn[] = [];
      const indexColumns: RawColumn[] = [];
      let rowEstimate: number | null = null;
      try {
        const desc = await low.send(new DescribeTableCommand({ TableName: t }));
        const table = desc.Table;
        const attrs = new Map<string, string>();
        for (const a of table?.AttributeDefinitions ?? []) {
          if (typeof a.AttributeName === "string") {
            attrs.set(a.AttributeName, ddbTypeString(a.AttributeType));
          }
        }
        const indexes = [...(table?.GlobalSecondaryIndexes ?? []), ...(table?.LocalSecondaryIndexes ?? [])];
        for (const ix of indexes) {
          for (const k of ix.KeySchema ?? []) {
            if (typeof k.AttributeName === "string") {
              indexColumns.push({ name: k.AttributeName, type: attrs.get(k.AttributeName) ?? "string", nullable: true });
            }
          }
        }
        for (const k of table?.KeySchema ?? []) {
          if (typeof k.AttributeName === "string") {
            keyColumns.push({
              name: k.AttributeName,
              type: attrs.get(k.AttributeName) ?? "string",
              nullable: false,
            });
          }
        }
        rowEstimate =
          typeof table?.ItemCount === "number" ? table.ItemCount : null;
      } catch {
      }

      const columns = new Map<string, RawColumn>();
      for (const kc of keyColumns) columns.set(kc.name, { ...kc });
      for (const ic of indexColumns) if (!columns.has(ic.name)) columns.set(ic.name, ic);

      tables.push({
        name: t,
        columns: Array.from(columns.values()),
        rowEstimate,
      });
    }

    return {
      dialect: "dynamodb",
      tables,
      skippedUnsafeNames,
      namesSeenTotal: allNames.length,
      deadlineHit,
      listingTruncated };
  } finally {
    try {
      low.destroy();
    } catch {
    }
  }
}
