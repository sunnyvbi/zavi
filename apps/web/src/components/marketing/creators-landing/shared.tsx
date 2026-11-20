
export const CREATOR_JOIN_HREF = "/creators/apply";

export const CREATOR_SIGNIN_HREF = "/creators/login";

export const PRIMARY =
  "inline-flex min-h-12 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[16px] font-semibold text-white transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]";
export const SECONDARY =
  "inline-flex min-h-12 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-black/[0.1] bg-white/80 px-6 text-[16px] font-semibold text-[#0e0f11] backdrop-blur transition-colors duration-200 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]";

export function ExampleTag({ dark }: { dark?: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-[0.06em] uppercase ${
        dark ? "bg-black/45 text-white backdrop-blur-sm" : "bg-black/[0.05] text-[#595959]"
      }`}
    >
      Example
    </span>
  );
}
