
import Link from "next/link";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { ZaviMascot } from "@/components/ZaviMascot";

export default function NotFound() {
  return (
    <main
      id="zavi-main"
      className="min-h-screen bg-cream text-ink flex items-center justify-center px-6"
    >
      <div className="w-full max-w-[480px] text-center">
        <div className="flex justify-center mb-10">
          <ZaviWordmark size="lg" />
        </div>

        {}
        <div className="mb-6 flex justify-center">
          <ZaviMascot size={120} />
        </div>

        <div className="kicker text-violet mb-3">404 · skill misfired</div>
        <h1 className="font-display font-semibold text-[28px] md:text-[34px] tracking-tighter text-ink leading-[1.1]">
          A skill misfired. <span className="italic text-violet">It happens.</span>
        </h1>
        <p className="mt-4 text-[16px] leading-[1.6] text-inkMuted">
          The fleet keeps running. The route you followed is stale, mistyped,
          or points at a surface we haven't built yet.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row gap-2.5 justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-ink text-cream px-4 py-2.5 text-[16px] font-semibold hover:bg-violet transition-colors"
          >
            ← Marketing home
          </Link>
        </div>
      </div>
    </main>
  );
}
