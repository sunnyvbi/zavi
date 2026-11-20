"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { installAttributionLinks } from "@/lib/marketing/attributionLinks";

export function AttributionLinks() {
  const router = useRouter();
  useEffect(() => installAttributionLinks(href => router.push(href)), [router]);
  return null;
}
