"use client";

import Image from "next/image";
import { useState } from "react";
import { FileText, ImageOff } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";

function LoadingImage({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && (
        <span data-testid="thumbnail-pending" className="absolute inset-0">
          <Skeleton className="size-10" />
        </span>
      )}
      <Image
        src={src}
        alt={`${name} creative`}
        width={40}
        height={40}
        unoptimized
        loading="eager"
        onLoad={() => setLoaded(true)}
        onError={onError}
        data-loaded={loaded ? "true" : "false"}
        className={`relative size-10 object-cover transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </>
  );
}

export function CampaignThumbnailView({ image, name, loading = false, textOnly = false, onError }: { image: string | null; name: string; loading?: boolean; textOnly?: boolean; onError: () => void }) {
  const Icon = textOnly ? FileText : ImageOff;
  return <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-creamDeep ring-1 ring-inset ring-rule">
    {image ? <LoadingImage key={image} src={image} name={name} onError={onError} /> : loading ? <Skeleton className="size-10" /> : <Icon className="size-4 text-inkMuted" role="img" aria-label={`${name}: ${textOnly ? "text-only campaign" : "media unavailable"}`} />}
  </span>;
}
