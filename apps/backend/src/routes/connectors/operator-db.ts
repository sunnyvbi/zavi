
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { markCatalogRediscovering } from "@/services/tools/operator-db/discovery";
import { probeCandidate, readDbGeneration, readOnlyCheckOf, recordDbTransport, requireTlsByDefault } from "@/services/data-gateway";
import { sanitizeDiscoveryError } from "@/services/tools/operator-db/discovery/errors";
import { parseDynamodbUri } from "@/services/tools/operator-db/dynamodb-uri";
import { ExpectedToolError } from "@/services/tools/types";
import { inngest } from "@/../workers/client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { publishRevoke } from "@/services/data-gateway/connector/wakeup";

const SCHEMES_BY_TYPE: Record<string, string[]> = {
  postgres: ["postgres:", "postgresql:"],
  mysql: ["mysql:"],
  mongodb: ["mongodb:", "mongodb+srv:"],
  dynamodb: ["dynamodb:"],
};

function schemeOf(connectionString: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(connectionString.trim());
  return m ? `${m[1].toLowerCase()}:` : null;
}

const bodySchema = z.object({
  type: z.enum(["postgres", "mongodb", "mysql", "dynamodb"]),
  connection_string: z.string().min(8),
  schema_map: z.unknown().optional(),
});

export async function operatorDbConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    });
    return;
  }

  const { type, connection_string } = parsed.data;

  const scheme = schemeOf(connection_string);
  const allowed = SCHEMES_BY_TYPE[type] ?? [];
  if (!scheme || !allowed.includes(scheme)) {
    res.status(400).json({
      error: {
        code: "operator_db_scheme_type_mismatch",
        message:
          `You selected "${type}", but the connection string ` +
          (scheme
            ? `uses the "${scheme}//" scheme.`
            : "does not start with a URI scheme.") +
          ` A ${type} connection string must start with ${allowed
            .map((x) => `"${x}//"`)
            .join(" or ")}.`,
      },
    });
    return;
  }

  if (type === "dynamodb") {
    try {
      parseDynamodbUri(connection_string);
    } catch (e) {
      if (e instanceof ExpectedToolError) {
        res.status(400).json({ error: { code: e.code, message: e.message } });
        return;
      }
      throw e;
    }
  }

  const gate = await serverClientFromBearer(auth.access_token).rpc("_assert_tenant_admin", {
    p_tenant_id: auth.tenant_id,
  });
  if (gate.error) {
    console.warn("operator_db_connect_forbidden", {
      tenant_id: auth.tenant_id,
      error_code: gate.error.code,
    });
    res.status(403).json({
      error: {
        code: "operator_db_not_tenant_admin",
        message: "Only a workspace owner or admin can connect a database.",
      },
    });
    return;
  }

  const stored_connection = requireTlsByDefault(type, connection_string);
  const probe = await probeCandidate(
    { tenant_id: auth.tenant_id, caller: { kind: "background", feature: "Connection test" } },
    type,
    stored_connection,
  );
  if (!probe.ok) {
    res.status(200).json({
      ok: false,
      type,
      discovery_error: probe.error,
    });
    return;
  }

  const { error } = await serverClientFromBearer(auth.access_token).rpc(
    "set_operator_db_connection",
    {
      p_tenant_id: auth.tenant_id,
      p_type: type,
      p_connection_string: stored_connection,
      p_schema_map: {},
    },
  );

  if (error) {
    console.error("operator_db_connect_failed", {
      tenant_id: auth.tenant_id,
      type,
      error_code: error.code,
      error_message: sanitizeDiscoveryError(error),
    });
    res.status(500).json({
      error: {
        code: "operator_db_connect_failed",
        message: "Failed to save your database connection. Check server logs.",
      },
    });
    return;
  }

  await publishRevoke(auth.tenant_id).catch(() => undefined);
  await recordDbTransport(auth.tenant_id, type, stored_connection);

  const writeCapable = probe.write_capable;

  try {
    const generation = await Promise.resolve().then(() => readDbGeneration(auth.tenant_id)).catch(() => undefined);
    await inngest.send({
      name: "operator-db.discover.requested",
      data: { tenant_id: auth.tenant_id, ...(generation !== undefined ? { generation } : {}) },
    });
  } catch (e) {
    console.warn(
      `[connectors/operator-db] enqueue discovery failed for tenant ${auth.tenant_id}: ${(e as Error).message}`,
    );
    try {
      await markCatalogRediscovering(auth.tenant_id, type);
    } catch (e2) {
      console.warn(
        `[connectors/operator-db] catalog invalidate failed for tenant ${auth.tenant_id}: ${(e2 as Error).message}`,
      );
    }
  }

  try {
    await inngest.send({
      name: "booking-mapping.detect.requested",
      data: { tenant_id: auth.tenant_id },
    });
  } catch (e) {
    console.warn(
      `[connectors/operator-db] enqueue booking-mapping detect failed for tenant ${auth.tenant_id}: ${(e as Error).message}`,
    );
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "operator_db" } });
  res.json({
    ok: true,
    type,
    write_capable: writeCapable,
    read_only_check: readOnlyCheckOf(type, writeCapable),
    discovery: "pending",
  });
}
