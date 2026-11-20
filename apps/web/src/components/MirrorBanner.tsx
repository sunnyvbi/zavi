export function MirrorBanner() {
  if (process.env.NEXT_PUBLIC_ZAVI_MIRROR !== "1") return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-[1000] w-full bg-red-600 px-4 py-1 text-center text-xs font-semibold text-white"
    >
      MIRROR: copied data, real accounts. Slack posts, ad changes and publishing are real.
    </div>
  );
}
