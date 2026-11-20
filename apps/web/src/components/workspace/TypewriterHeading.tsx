"use client";

export const TYPEWRITER_PHRASES = {
  grow: ["start"],
  build: ["start"],
};

export function TypewriterHeading({
  className,
  mode,
}: {
  className?: string;
  mode: "build" | "grow";
}) {
  const phrase = TYPEWRITER_PHRASES[mode][0];
  return (
    <h1 className={className}>{`Let's ${phrase}`}</h1>
  );
}
