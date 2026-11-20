import Link from "next/link";
import { liveFromParam } from "@/lib/marketing/liveFrom";
import { Radio } from "lucide-react";

export function LiveRunBanner({ from, website }: { from: string; website: string }) {
  if (!liveFromParam(from)) return null;
  const slug = from.slice("live-".length);
  const company = slug.charAt(0).toUpperCase() + slug.slice(1);
  const site = website.trim();
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-[#027bff]/25 bg-[#027bff]/[0.07] px-4 py-2 text-[14px]">
      <Radio aria-hidden className="h-4 w-4 text-[#ff4d4f]" />
      <span className="font-semibold text-ink">From the Zavi × {company} live run.</span>
      <span className="text-[#4b5058]">{site ? `Same agent, now looking at ${site}.` : "Same agent, now for your business."}</span>
      <Link href={`/live/${slug}`} className="ml-auto font-semibold text-[#027bff]">
        Back to the run
      </Link>
    </div>
  );
}
