import { File, FileImage, Folder, FolderOpen, Lock } from "lucide-react";
import { cx } from "../layout/shared";

type Glyph = { text: string; className: string };

const BY_EXT: Record<string, Glyph> = {
  ts: { text: "TS", className: "text-[#3178c6]" },
  mts: { text: "TS", className: "text-[#3178c6]" },
  tsx: { text: "⚛", className: "text-[#1a9fd8]" },
  jsx: { text: "⚛", className: "text-[#1a9fd8]" },
  js: { text: "JS", className: "text-[#c9a400]" },
  mjs: { text: "JS", className: "text-[#c9a400]" },
  cjs: { text: "JS", className: "text-[#c9a400]" },
  json: { text: "{}", className: "text-[#c9a400]" },
  css: { text: "#", className: "text-[#4d8fd6]" },
  html: { text: "<>", className: "text-[#e2622c]" },
  md: { text: "M↓", className: "text-[#4d8fd6]" },
  toml: { text: "⚙", className: "text-inkMuted" },
  yml: { text: "!", className: "text-[#c4474d]" },
  yaml: { text: "!", className: "text-[#c4474d]" },
  sql: { text: "DB", className: "text-[#e2622c]" },
  sh: { text: "$", className: "text-[#58a55c]" },
  lock: { text: "", className: "" },
};

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;

export function CodeFileIcon({ path, className }: { path: string; className?: string }) {
  const name = path.split("/").pop() ?? path;
  if (IMAGE.test(name)) {
    return <FileImage aria-hidden className={cx("h-4 w-4 shrink-0 text-[#a074c4]", className)} />;
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "lock" || name === "bun.lockb") {
    return <Lock aria-hidden className={cx("h-3.5 w-3.5 shrink-0 text-inkMuted", className)} />;
  }
  const glyph = BY_EXT[ext];
  if (!glyph || !glyph.text) {
    return <File aria-hidden className={cx("h-4 w-4 shrink-0 text-inkMuted", className)} />;
  }
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center font-mono text-[9.5px] font-bold leading-none",
        glyph.className,
        className,
      )}
    >
      {glyph.text}
    </span>
  );
}

export function CodeFolderIcon({ open }: { open: boolean }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon aria-hidden className="h-4 w-4 shrink-0 text-[#c09553]" />;
}
