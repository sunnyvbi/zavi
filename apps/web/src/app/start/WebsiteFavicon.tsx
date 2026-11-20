"use client";

import Image from "next/image";
import { Globe } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { faviconUrlFromDomain } from "@/lib/favicon";
import { websiteHost } from "./websiteHost";

export function WebsiteFavicon({ value }: { value: string }) {
  const host = websiteHost(value);
  return <FaviconImage key={host ?? "empty"} host={host} />;
}

function FaviconImage({ host }: { host: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const src = host ? faviconUrlFromDomain(host) : null;

  return (
    <span aria-hidden="true" className="relative block size-5 shrink-0">
      {!loaded && <Globe className="absolute inset-0 size-5" strokeWidth={1.5} />}
      {src && (
        <Image
          src={src}
          alt=""
          width={20}
          height={20}
          unoptimized
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          className={cn(
            "absolute inset-0 size-5 rounded object-contain transition-opacity duration-200 motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </span>
  );
}
