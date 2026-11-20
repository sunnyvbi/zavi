import { useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PostImageSize } from "@zavi/shared";
import { usePostImageSource } from "./usePostImageSource";
import { MediaExpand } from "./card/blocks/MediaExpand";

const sizes = { feed: "aspect-ad-feed", square: "aspect-square", story: "aspect-ad-vertical", pin: "aspect-ad-pin" };
export function PostPhoto({ source, headline, size = "feed", rendered = false, thumbnail = false, fallback, expandable = false }: { source: string; headline?: string; size?: PostImageSize; rendered?: boolean; thumbnail?: boolean; fallback?: string; expandable?: boolean }) {
  const image = usePostImageSource(source);
  const src = image.src ?? (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api\/public\/workspace-files\//.test(source) ? source : null);
  const [failed, setFailed] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  if (src && src !== last && src !== failed) setLast(src);
  const usable = (url?: string | null) => (url && url !== failed ? url : null);
  const broken = image.failed || (!!src && failed === src);
  const shown = broken ? null : usable(src) ?? usable(fallback) ?? usable(last);
  return <div className={cn("group/media relative w-full overflow-hidden bg-creamDeep", sizes[size])}>
    {shown
      ? <img loading={thumbnail ? "lazy" : "eager"} onError={() => setFailed(shown)} src={shown} alt={headline || "Post photo"} className="size-full object-cover" />
      : thumbnail
        ? <span role="status" aria-label={broken ? "Photo could not be loaded." : "Loading photo"} className={cn("grid size-full place-items-center bg-bone text-inkMuted", !broken && "animate-pulse motion-reduce:animate-none")}>{broken && <ImageOff className="size-4" aria-hidden />}</span>
        : <p role="status" className="p-5 text-sm text-inkMuted">{broken ? "Photo could not be loaded." : "Loading photo…"}</p>}
    {!rendered && headline && <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-16"><p className="break-words text-xl font-semibold text-white">{headline}</p></div>}
    {expandable && shown && <MediaExpand url={shown} alt={headline || "Post photo"} cover />}
  </div>;
}
