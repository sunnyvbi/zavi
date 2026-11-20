"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { PostDialog, type PostTargetName } from "../videoStudio/PostDialog";
import { btn } from "./ui";

export function PostVideoButton({ artifactId, title }: { artifactId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [posted, setPosted] = useState<PostTargetName[]>([]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="video-post" className={btn.primary}>
        <Send className="h-4 w-4" aria-hidden />
        Post this video
      </button>
      {open && (
        <PostDialog
          artifactId={artifactId}
          title={title}
          posted={posted}
          onPosted={(names) => setPosted((p) => [...new Set([...p, ...names])])}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
