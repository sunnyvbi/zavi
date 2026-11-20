"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type ProductUrl = { marketing?: string; api?: string };

let cached: ProductUrl | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

let loadFailed = false;

export function coerceProductUrl(v: unknown): ProductUrl {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: ProductUrl = {};
  if (typeof o.marketing === "string" && o.marketing) out.marketing = o.marketing;
  if (typeof o.api === "string" && o.api) out.api = o.api;
  return out;
}

function load(): Promise<void> {
  if (cached && !loadFailed) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await apiFetch("/api/connectors/product-url");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { product_url?: unknown };
      cached = coerceProductUrl(body.product_url);
      loadFailed = false;
    } catch {
      cached = {};
      loadFailed = true;
    } finally {
      inflight = null;
      for (const l of Array.from(listeners)) l();
    }
  })();
  return inflight;
}

export function useProductUrl(): ProductUrl | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void load();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return cached;
}

export type ProductUrlState =
  | { status: "loading" }
  | { status: "ok"; value: ProductUrl }
  | { status: "error" };

export function useProductUrlState(): ProductUrlState {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void load();
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (cached === null) return { status: "loading" };
  if (loadFailed) return { status: "error" };
  return { status: "ok", value: cached };
}

export function retryProductUrl(): Promise<void> {
  return load();
}

export function __loadProductUrlForTest(): Promise<void> {
  return load();
}

export function __resetProductUrlCache(): void {
  cached = null;
  inflight = null;
  loadFailed = false;
  listeners.clear();
}
