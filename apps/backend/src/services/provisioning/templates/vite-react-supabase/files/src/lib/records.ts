import { supabase } from "./supabase";

export type Row = Record<string, unknown> & { id: string };

type AnyValues = never;

function client() {
  if (!supabase) throw new Error("This site is not connected to its database yet.");
  return supabase;
}

export async function listRecords<T extends Row>(
  table: string,
  opts: { orderBy?: string; ascending?: boolean; limit?: number; match?: Record<string, unknown> } = {},
): Promise<T[]> {
  let q = client().from(table).select("*");
  if (opts.match) q = q.match(opts.match);
  if (opts.orderBy) q = q.order(opts.orderBy, { ascending: opts.ascending ?? false });
  q = q.limit(opts.limit ?? 100);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function getRecord<T extends Row>(table: string, id: string): Promise<T | null> {
  const { data, error } = await client().from(table).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as T | null) ?? null;
}

export async function createRecord<T extends Row>(table: string, values: Partial<T>): Promise<T> {
  const { data, error } = await client().from(table).insert(values as AnyValues).select("*").single();
  if (error) throw error;
  return data as T;
}

export async function updateRecord<T extends Row>(table: string, id: string, values: Partial<T>): Promise<T> {
  const { data, error } = await client().from(table).update(values as AnyValues).eq("id", id).select("*").single();
  if (error) throw error;
  return data as T;
}

export async function deleteRecord(table: string, id: string): Promise<void> {
  const { error } = await client().from(table).delete().eq("id", id);
  if (error) throw error;
}
