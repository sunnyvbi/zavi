
import { asTenantId, tenantClient } from "@/services/tenant-client";
import {
  authorizeCreatorThreadAccess,
  ensureCreatorThread,
  listCreatorThreadMessages,
  postCreatorThreadMessage,
  type CreatorThreadAccess,
} from "@/services/creators/thread";
import { createLibraryAssetOnApproval } from "@/services/creators/library";

export type CreatorThreadMessage = {
  id: string;
  sender_kind: "tenant" | "creator" | "staff" | "system";
  body: string;
  created_at: string;
};

export type CreatorThreadView = {
  available: boolean;
  thread_id: string | null;
  messages: CreatorThreadMessage[];
};

export type CreatorThreadPort = {
  readThread(args: {
    auth_user_id: string;
    tenant_id: string;
    order_id: string;
    thread_id: string | null;
  }): Promise<CreatorThreadView>;

  postMessage(args: {
    auth_user_id: string;
    tenant_id: string;
    order_id: string;
    thread_id: string | null;
    body: string;
  }): Promise<{ posted: boolean }>;
};

export const unavailableThreadPort: CreatorThreadPort = {
  async readThread(args) {
    return { available: false, thread_id: args.thread_id, messages: [] };
  },
  async postMessage() {
    return { posted: false };
  },
};

export type ThreadPortDeps = {
  authorize: typeof authorizeCreatorThreadAccess;
  list: typeof listCreatorThreadMessages;
  post: typeof postCreatorThreadMessage;
  orderThreadId: (tenant_id: string, order_id: string) => Promise<string | null>;
  openThread?: (tenant_id: string, order_id: string, auth_user_id: string) => Promise<string | null>;
};

export async function orderThreadId(tenant_id: string, order_id: string): Promise<string | null> {
  const client = tenantClient(asTenantId(tenant_id));
  const { data, error } = await client
    .from("creator_orders")
    .select("thread_id, human_member_id")
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`creator_orders thread read failed: ${error.message}`);
  const order = data as { thread_id?: string | null; human_member_id?: string | null } | null;
  if (order?.thread_id) return order.thread_id;
  if (!order?.human_member_id) return null;
  const pair = await client
    .from("creator_threads")
    .select("id")
    .eq("human_member_id", order.human_member_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pair.error) throw new Error(`creator_threads read failed: ${pair.error.message}`);
  return (pair.data as { id?: string } | null)?.id ?? null;
}

export async function openOrderThread(tenant_id: string, order_id: string, auth_user_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_orders")
    .select("human_member_id")
    .eq("id", order_id)
    .maybeSingle();
  if (error) throw new Error(`creator_orders read failed: ${error.message}`);
  const human_member_id = (data as { human_member_id?: string | null } | null)?.human_member_id;
  if (!human_member_id) return null;
  const thread = await ensureCreatorThread({ tenant_id, human_member_id, started_by: "tenant", started_by_user_id: auth_user_id });
  return thread.id;
}

const realThreadDeps: ThreadPortDeps = {
  authorize: authorizeCreatorThreadAccess,
  list: listCreatorThreadMessages,
  post: postCreatorThreadMessage,
  orderThreadId,
  openThread: openOrderThread,
};

async function businessAccess(
  deps: ThreadPortDeps,
  args: { auth_user_id: string; tenant_id: string; thread_id: string },
): Promise<CreatorThreadAccess | null> {
  const r = await deps.authorize({ auth_user_id: args.auth_user_id, thread_id: args.thread_id });
  if (!r.ok) return null;
  if (r.access.tenant_id !== args.tenant_id) return null;
  if (r.access.sender_kind !== "tenant") return null;
  return r.access;
}

export function makeCreatorThreadPort(deps: ThreadPortDeps = realThreadDeps): CreatorThreadPort {
  return {
    async readThread(args) {
      const thread_id = args.thread_id ?? (await deps.orderThreadId(args.tenant_id, args.order_id));
      if (!thread_id) return { available: true, thread_id: null, messages: [] };
      const access = await businessAccess(deps, { ...args, thread_id });
      if (!access) return { available: false, thread_id: null, messages: [] };
      const rows = await deps.list(access);
      return {
        available: true,
        thread_id,
        messages: rows.map((m) => ({
          id: m.id,
          sender_kind: m.sender_kind as CreatorThreadMessage["sender_kind"],
          body: m.body,
          created_at: m.created_at,
        })),
      };
    },
    async postMessage(args) {
      const thread_id =
        args.thread_id ??
        (await deps.orderThreadId(args.tenant_id, args.order_id)) ??
        (deps.openThread ? await deps.openThread(args.tenant_id, args.order_id, args.auth_user_id) : null);
      if (!thread_id) return { posted: false };
      const access = await businessAccess(deps, { ...args, thread_id });
      if (!access) return { posted: false };
      await deps.post({ access, sender_user_id: args.auth_user_id, body: args.body });
      return { posted: true };
    },
  };
}

export const realCreatorThreadPort: CreatorThreadPort = makeCreatorThreadPort();

export type CreatorLibraryPort = {
  createLibraryAssetOnApproval(
    tenant_id: string,
    order_id: string,
  ): Promise<{ created: boolean; asset_id?: string | null }>;
};

export const noopLibraryPort: CreatorLibraryPort = {
  async createLibraryAssetOnApproval() {
    return { created: false, asset_id: null };
  },
};

export const realCreatorLibraryPort: CreatorLibraryPort = {
  async createLibraryAssetOnApproval(tenant_id, order_id) {
    const out = await createLibraryAssetOnApproval(asTenantId(tenant_id), order_id);
    return { created: out.created, asset_id: out.asset?.id ?? null };
  },
};
