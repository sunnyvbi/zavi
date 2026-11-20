
import { fbPost } from "../_client";
import { shapeSetStatusRequest } from "./_request-shapers";
import { assertGraphWriteSucceeded } from "./_helpers";

export async function metaSetStatus(
  tenant_id: string,
  input: {
    object_id: string;
    level: "campaign" | "adset" | "ad";
    status: "ACTIVE" | "PAUSED";
  },
): Promise<{ id: string; status: "ACTIVE" | "PAUSED" }> {
  const { path, params } = shapeSetStatusRequest(input);
  const r = (await fbPost(tenant_id, path, params, { safety: input.status === "PAUSED" })) as { id?: string; success?: boolean };
  assertGraphWriteSucceeded(r, "status change");
  return {
    id: r.id ?? input.object_id,
    status: input.status,
  };
}
