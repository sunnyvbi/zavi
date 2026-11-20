"use client";

import { useState } from "react";
import Image from "next/image";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export function AiProviderIcon({ domain, className }: { domain: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MessageCircle className={cn("h-5 w-5 shrink-0", className)} aria-hidden />;
  return (
    <Image
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
      width={20}
      height={20}
      alt=""
      unoptimized
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("h-5 w-5 shrink-0 object-contain", className)}
    />
  );
}
