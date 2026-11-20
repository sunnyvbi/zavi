
import { WebsiteForm } from "../GrowthHero";
import { jakartaHeavy } from "../fonts";
import { ChannelGlyph, type ChannelPage } from "./channelPages";

export function ChannelPageBody({ c, startHref }: { c: ChannelPage; startHref: string }) {
  const icon = <ChannelGlyph channel={c} />;
  const form = <WebsiteForm startHref={startHref} id={`channel-${c.id}`} cta="Go to dashboard" />;
  const ctaForm = <WebsiteForm startHref={startHref} id={`channel-cta-${c.id}`} tone="dark" />;
  return (
    <>
      <div className="flex flex-col px-4 pt-24 pb-8 sm:px-6 sm:pt-28 lg:px-12">
        <section className="relative isolate flex min-h-[70vh] flex-col overflow-hidden rounded-block lg:rounded-[39px]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
            style={{ backgroundImage: "url('/marketing/growth-home/hero-bg.webp')" }}
          ></div>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 bg-white/25"></div>
          <div className="relative z-10 mx-auto flex w-full max-w-[820px] flex-1 flex-col items-center justify-center px-6 py-16 text-center sm:py-24">
            <nav aria-label="Breadcrumb">
              <ol className="inline-flex min-h-10 items-center gap-2 rounded-full border border-black/[0.08] bg-white px-4 text-[16px] text-[#595959] shadow-[0_1px_2px_rgba(16,18,20,0.04)]">
                <li>
                  <a
                    className="rounded-md transition-colors duration-200 hover:text-[#0e0f11] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]"
                    href="/"
                  >
                    Zavi growth agent
                  </a>
                </li>
                <li aria-hidden="true">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-chevron-right h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </li>
                <li
                  aria-current="page"
                  className="inline-flex items-center gap-2 font-semibold text-[#0e0f11]"
                >
                  {icon}
                  {c.agent}
                </li>
              </ol>
            </nav>
            <h1
              className={`${jakartaHeavy.className} mt-6 text-[clamp(2.4rem,6vw,4rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-[#0e0f11]`}
            >
              {c.agent}
            </h1>
            <p className="mt-5 max-w-[62ch] text-[18px] leading-relaxed text-[#595959] sm:text-[20px]">
              {c.desc}
            </p>
            <p className="mt-4 text-[14px] text-[#6b6b6b]">{c.note}</p>
            {form}
          </div>
        </section>
      </div>
      <section className="bg-white py-20 lg:py-28">
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <div className="mx-auto max-w-[760px] text-center">
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
              The old way vs. the new way
            </h2>
            <p className="mx-auto mt-4 max-w-[62ch] text-[16px] leading-relaxed text-[#595959]">
              Running {c.name} used to mean agencies, guesswork, and reports that never fixed anything. Zavi
              does the work and waits for your yes.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-[880px] items-stretch gap-5 md:grid-cols-2">
            <div className="flex h-full flex-col rounded-block border p-8 transition-all duration-300 border-black/[0.08] bg-[#f9f9f9]">
              <div className="flex items-center justify-between">
                <p className="text-[16px] font-semibold tracking-[0.12em] uppercase text-[#595959]">
                  The old way
                </p>
              </div>
              <ul className="mt-6 space-y-4">
                <li className="flex items-start gap-3 text-[16px] text-[#0e0f11]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-x mt-0.5 size-5 shrink-0 text-[#9ca3af]"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                  Hours every week you don&#x27;t have, or a retainer before you see results
                </li>
                <li className="flex items-start gap-3 text-[16px] text-[#0e0f11]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-x mt-0.5 size-5 shrink-0 text-[#9ca3af]"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                  Guesswork on what to change next
                </li>
                <li className="flex items-start gap-3 text-[16px] text-[#0e0f11]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-x mt-0.5 size-5 shrink-0 text-[#9ca3af]"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                  You find out what failed weeks late
                </li>
              </ul>
            </div>
            <div className="flex h-full flex-col rounded-block border p-8 transition-all duration-300 border-[#cddbe8] bg-white shadow-[0_28px_70px_-34px_rgba(16,18,20,0.30)]">
              <div className="flex items-center justify-between">
                <p className="text-[16px] font-semibold tracking-[0.12em] uppercase text-[#027bff]">
                  With Zavi
                </p>
                <span className="rounded-full bg-[#e6f2ff] px-2.5 py-1 text-[13px] font-semibold text-[#027bff]">
                  Recommended
                </span>
              </div>
              <ul className="mt-6 space-y-4">
                <li className="flex items-start gap-3 text-[16px] text-[#0e0f11]">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-check size-3"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  One agent runs {c.name} for you
                </li>
                <li className="flex items-start gap-3 text-[16px] text-[#0e0f11]">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-check size-3"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  Acts on your real numbers, not guesses
                </li>
                <li className="flex items-start gap-3 text-[16px] text-[#0e0f11]">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-check size-3"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  Every change waits for your yes
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
      <section className="bg-white py-20 lg:py-28">
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <div className="mx-auto max-w-[760px] text-center">
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
              Live on {c.name} in three steps
            </h2>
            <p className="mx-auto mt-4 max-w-[62ch] text-[16px] leading-relaxed text-[#595959]">
              Connect once, let the agent do the work, and approve what ships. You stay in control the whole
              way.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            <div className="relative flex min-h-[440px] flex-col overflow-hidden rounded-[20px] border border-black/[0.06] p-7 shadow-[0_13px_28.6px_-12px_rgba(16,18,20,0.18)]">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundColor: "#ffffff",
                  backgroundImage:
                    "radial-gradient(58% 78% at 100% 44%, #78bfff 0%, rgba(120,191,255,0) 70%), radial-gradient(46% 46% at 50% 90%, #9bccff 0%, rgba(155,204,255,0) 72%), radial-gradient(72% 95% at 12% 46%, #fcf3ea 0%, rgba(252,243,234,0) 78%)",
                }}
              ></div>
              <div className="relative z-10 flex h-full flex-col">
                <span className="flex size-9 items-center justify-center rounded-full bg-[#0e0f11] text-[16px] font-semibold text-white">
                  1
                </span>
                <h3 className="mt-5 text-[20px] font-bold text-[#0e0f11]">Connect</h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[#595959]">
                  Connect your {c.name} account in two clicks. Zavi reads your real history, not a template.
                </p>
                <div className="mt-auto pt-8">
                  <div className="rounded-[16px] p-4 border border-white/60 bg-white/55 backdrop-blur-[6px] shadow-[0_13px_28.6px_-14px_rgba(16,18,20,0.20)]">
                    <div className="flex items-center gap-3">
                      <span className="flex size-10 items-center justify-center rounded-xl bg-white [&>svg]:size-5">
                        {icon}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[14px] font-semibold text-[#0e0f11]">{c.name}</p>
                        <p className="text-[13px] text-[#595959]">Ad account</p>
                      </div>
                      <span className="ml-auto flex items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold text-[#167f50]">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>{" "}
                        Connected
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-2 rounded-[12px] bg-white/70 px-3 py-2.5 text-[13px] text-[#595959]">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      Two clicks. Nothing changes without your yes.
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="relative flex min-h-[440px] flex-col overflow-hidden rounded-[20px] border border-black/[0.06] p-7 shadow-[0_13px_28.6px_-12px_rgba(16,18,20,0.18)]">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundColor: "#ffffff",
                  backgroundImage:
                    "radial-gradient(58% 78% at 100% 44%, #78bfff 0%, rgba(120,191,255,0) 70%), radial-gradient(46% 46% at 50% 90%, #9bccff 0%, rgba(155,204,255,0) 72%), radial-gradient(72% 95% at 12% 46%, #fcf3ea 0%, rgba(252,243,234,0) 78%)",
                }}
              ></div>
              <div className="relative z-10 flex h-full flex-col">
                <span className="flex size-9 items-center justify-center rounded-full bg-[#0e0f11] text-[16px] font-semibold text-white">
                  2
                </span>
                <h3 className="mt-5 text-[20px] font-bold text-[#0e0f11]">Zavi works</h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[#595959]">
                  The agent finds what to change, drafts the work, and prepares the next move.
                </p>
                <div className="mt-auto pt-8">
                  <div className="rounded-[16px] p-4 border border-white/60 bg-white/55 backdrop-blur-[6px] shadow-[0_13px_28.6px_-14px_rgba(16,18,20,0.20)]">
                    <div className="flex items-center gap-2">
                      <span className="flex size-6 items-center justify-center rounded-full bg-[#e6f2ff] text-[#027bff]">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-sparkles size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
                          <path d="M20 2v4" />
                          <path d="M22 4h-4" />
                          <circle cx="4" cy="20" r="2" />
                        </svg>
                      </span>
                      <span className="text-[13px] font-semibold text-[#0e0f11]">
                        Zavi drafted your next {c.name} move
                      </span>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center gap-2 rounded-[10px] bg-[#fdeceb]/80 px-3 py-2 text-[13px] text-[#b42318]">
                        <span className="font-semibold">−</span> Pause the ad set that&#x27;s losing money
                      </div>
                      <div className="flex items-center gap-2 rounded-[10px] bg-[#f5faf8]/80 px-3 py-2 text-[13px] text-[#167f50]">
                        <span className="font-semibold">+</span> Shift budget to the winner
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="relative flex min-h-[440px] flex-col overflow-hidden rounded-[20px] border border-black/[0.06] p-7 shadow-[0_13px_28.6px_-12px_rgba(16,18,20,0.18)]">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundColor: "#ffffff",
                  backgroundImage:
                    "radial-gradient(58% 78% at 100% 44%, #78bfff 0%, rgba(120,191,255,0) 70%), radial-gradient(46% 46% at 50% 90%, #9bccff 0%, rgba(155,204,255,0) 72%), radial-gradient(72% 95% at 12% 46%, #fcf3ea 0%, rgba(252,243,234,0) 78%)",
                }}
              ></div>
              <div className="relative z-10 flex h-full flex-col">
                <span className="flex size-9 items-center justify-center rounded-full bg-[#0e0f11] text-[16px] font-semibold text-white">
                  3
                </span>
                <h3 className="mt-5 text-[20px] font-bold text-[#0e0f11]">You approve</h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[#595959]">
                  Review it in plain English and approve. Nothing goes live without your yes.
                </p>
                <div className="mt-auto pt-8">
                  <div className="rounded-[16px] p-4 border border-white/60 bg-white/55 backdrop-blur-[6px] shadow-[0_13px_28.6px_-14px_rgba(16,18,20,0.20)]">
                    <p className="text-[13px] text-[#595959]">Waiting for your approval</p>
                    <p className="mt-1.5 text-[14px] font-semibold text-[#0e0f11]">
                      Move $40/day to your top performer?
                    </p>
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-4 py-2 text-[16px] font-semibold text-white"
                      >
                        Approve{" "}
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-arrow-right size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M5 12h14" />
                          <path d="m12 5 7 7-7 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-black/[0.12] bg-white/70 px-4 py-2 text-[16px] font-semibold text-[#595959]"
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="bg-white py-20 lg:py-28">
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <div className="mx-auto max-w-[760px] text-center">
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
              What the {c.agent} does
            </h2>
            <p className="mx-auto mt-4 max-w-[62ch] text-[16px] leading-relaxed text-[#595959]">
              From reading your numbers to drafting the work, here&#x27;s everything the agent handles on{" "}
              {c.name}, with your approval on every change.
            </p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="group rounded-[20px] border border-black/[0.08] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-[0_24px_50px_-24px_rgba(16,18,20,0.28)]">
              <span className="flex size-11 items-center justify-center rounded-[13px] transition-transform duration-300 group-hover:scale-105 bg-[#f9f9f9] text-[#4f46e5]">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-chart-column size-5"
                  aria-hidden="true"
                >
                  <path d="M3 3v16a2 2 0 0 0 2 2h16" />
                  <path d="M18 17V9" />
                  <path d="M13 17V5" />
                  <path d="M8 17v-3" />
                </svg>
              </span>
              <h3 className="mt-4 text-[16px] font-semibold text-[#0e0f11]">Reads your data</h3>
              <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                Pulls your {c.name} performance and finds where growth is stuck.
              </p>
            </div>
            <div className="group rounded-[20px] border border-black/[0.08] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-[0_24px_50px_-24px_rgba(16,18,20,0.28)]">
              <span className="flex size-11 items-center justify-center rounded-[13px] transition-transform duration-300 group-hover:scale-105 bg-[#f9f9f9] text-[#027bff]">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-search size-5"
                  aria-hidden="true"
                >
                  <path d="m21 21-4.34-4.34" />
                  <circle cx="11" cy="11" r="8" />
                </svg>
              </span>
              <h3 className="mt-4 text-[16px] font-semibold text-[#0e0f11]">Finds what to change</h3>
              <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                Spots the wins and the waste before they cost you.
              </p>
            </div>
            <div className="group rounded-[20px] border border-black/[0.08] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-[0_24px_50px_-24px_rgba(16,18,20,0.28)]">
              <span className="flex size-11 items-center justify-center rounded-[13px] transition-transform duration-300 group-hover:scale-105 bg-[#f9f9f9] text-[#db2777]">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-pen-line size-5"
                  aria-hidden="true"
                >
                  <path d="M13 21h8" />
                  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                </svg>
              </span>
              <h3 className="mt-4 text-[16px] font-semibold text-[#0e0f11]">Drafts the work</h3>
              <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                Writes the posts, ads, or fixes in your brand voice.
              </p>
            </div>
            <div className="group rounded-[20px] border border-black/[0.08] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-[0_24px_50px_-24px_rgba(16,18,20,0.28)]">
              <span className="flex size-11 items-center justify-center rounded-[13px] transition-transform duration-300 group-hover:scale-105 bg-[#f9f9f9] text-[#167f50]">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-trending-up size-5"
                  aria-hidden="true"
                >
                  <path d="M16 7h6v6" />
                  <path d="m22 7-8.5 8.5-5-5L2 17" />
                </svg>
              </span>
              <h3 className="mt-4 text-[16px] font-semibold text-[#0e0f11]">Proposes the next change</h3>
              <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                Ranks what to fix next, biggest blocker first.
              </p>
            </div>
            <div className="group rounded-[20px] border border-black/[0.08] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-[0_24px_50px_-24px_rgba(16,18,20,0.28)]">
              <span className="flex size-11 items-center justify-center rounded-[13px] transition-transform duration-300 group-hover:scale-105 bg-[#f9f9f9] text-[#e8590c]">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-shield-check size-5"
                  aria-hidden="true"
                >
                  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </span>
              <h3 className="mt-4 text-[16px] font-semibold text-[#0e0f11]">Waits for approval</h3>
              <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                Queues every change for your yes before it ships.
              </p>
            </div>
            <div className="group rounded-[20px] border border-black/[0.08] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-[0_24px_50px_-24px_rgba(16,18,20,0.28)]">
              <span className="flex size-11 items-center justify-center rounded-[13px] transition-transform duration-300 group-hover:scale-105 bg-[#f9f9f9] text-[#0d9488]">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-file-text size-5"
                  aria-hidden="true"
                >
                  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
                  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
                  <path d="M10 9H8" />
                  <path d="M16 13H8" />
                  <path d="M16 17H8" />
                </svg>
              </span>
              <h3 className="mt-4 text-[16px] font-semibold text-[#0e0f11]">Reports what moved</h3>
              <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                A plain-English recap of what changed and why.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section className="bg-white px-4 py-10 sm:px-6 lg:py-16">
        <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 rounded-blockLg bg-[#f9f9f9] px-6 py-14 sm:px-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16 lg:px-14 lg:py-16">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <h2 className="text-[clamp(1.9rem,3.6vw,2.8rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
              Why {c.name} matters for growth
            </h2>
            <p className="mt-4 max-w-[42ch] text-[16px] leading-relaxed text-[#595959]">
              {c.name} only works when someone stays on it. Zavi is that someone: consistent, data-led, and
              always waiting for your approval.
            </p>
          </div>
          <div className="rounded-[28px] border border-black/[0.06] bg-white p-8 shadow-[0_28px_70px_-42px_rgba(16,18,20,0.28)] sm:p-10">
            <div className="divide-y divide-black/[0.08]">
              <div className="flex items-start gap-5 py-6 first:pt-0">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#f9f9f9] text-[#4f46e5]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-clock size-5"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-[20px] font-bold text-[#0e0f11]">It compounds</h3>
                    <span className="rounded-full bg-[#f9f9f9] px-2.5 py-0.5 text-[13px] font-semibold text-[#595959]">
                      Over time
                    </span>
                  </div>
                  <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                    Steady work on {c.name} builds an audience that keeps paying off, long after a
                    one-off campaign goes quiet.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-5 py-6 first:pt-0">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#f9f9f9] text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-trending-up size-5"
                    aria-hidden="true"
                  >
                    <path d="M16 7h6v6" />
                    <path d="m22 7-8.5 8.5-5-5L2 17" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-[20px] font-bold text-[#0e0f11]">It reaches buyers</h3>
                    <span className="rounded-full bg-[#f9f9f9] px-2.5 py-0.5 text-[13px] font-semibold text-[#595959]">
                      High intent
                    </span>
                  </div>
                  <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                    {c.name} is where your customers already spend their attention, so the right message lands
                    in front of them.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-5 py-6 first:pt-0">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#f9f9f9] text-[#e8590c]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-shield-check size-5"
                    aria-hidden="true"
                  >
                    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-[20px] font-bold text-[#0e0f11]">It stays on-brand</h3>
                    <span className="rounded-full bg-[#f9f9f9] px-2.5 py-0.5 text-[13px] font-semibold text-[#595959]">
                      Your voice
                    </span>
                  </div>
                  <p className="mt-1.5 text-[16px] leading-relaxed text-[#595959]">
                    Every post and ad is drafted from your voice and your data, then waits for your yes
                    before it goes live.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="bg-white py-20 lg:py-28">
        <div className="mx-auto w-full max-w-[1120px] px-6">
          <div className="mx-auto max-w-[760px] text-center">
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
              Zavi vs. the alternatives
            </h2>
            <p className="mx-auto mt-4 max-w-[62ch] text-[16px] leading-relaxed text-[#595959]">
              Agencies, point tools, or doing it yourself: here&#x27;s how each stacks up against one agent
              that runs {c.name} for you.
            </p>
          </div>
          <div className="mt-12 overflow-hidden rounded-block border border-black/[0.08] bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-black/[0.08]">
                    <th className="px-6 py-4 text-[16px] font-semibold text-[#595959]">
                      {c.name} the manual way
                    </th>
                    <th className="px-4 py-4 text-center text-[16px] font-semibold text-[#595959]">
                      Doing it yourself
                    </th>
                    <th className="px-4 py-4 text-center text-[16px] font-semibold text-[#595959]">
                      An agency
                    </th>
                    <th className="px-4 py-4 text-center text-[16px] font-semibold text-[#595959]">
                      A point tool
                    </th>
                    <th className="px-4 py-4 text-center text-[16px] font-semibold bg-[#e6f2ff] text-[#0e0f11]">
                      Zavi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-black/[0.06]">
                    <th scope="row" className="px-6 py-4 text-[16px] font-medium text-[#0e0f11]">
                      Uses your real data
                    </th>
                    <td className="px-4 py-4 text-center ">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center bg-[#e6f2ff]">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                  <tr className="border-t border-black/[0.06]">
                    <th scope="row" className="px-6 py-4 text-[16px] font-medium text-[#0e0f11]">
                      Drafts the work for you
                    </th>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center bg-[#e6f2ff]">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                  <tr className="border-t border-black/[0.06]">
                    <th scope="row" className="px-6 py-4 text-[16px] font-medium text-[#0e0f11]">
                      Waits for your approval
                    </th>
                    <td className="px-4 py-4 text-center ">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center bg-[#e6f2ff]">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                  <tr className="border-t border-black/[0.06]">
                    <th scope="row" className="px-6 py-4 text-[16px] font-medium text-[#0e0f11]">
                      No retainer or per-seat fees
                    </th>
                    <td className="px-4 py-4 text-center ">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center bg-[#e6f2ff]">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                  <tr className="border-t border-black/[0.06]">
                    <th scope="row" className="px-6 py-4 text-[16px] font-medium text-[#0e0f11]">
                      Works across every channel
                    </th>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center ">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-x mx-auto size-5 text-[#9ca3af]"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-center bg-[#e6f2ff]">
                      <span className="mx-auto flex size-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="lucide lucide-check size-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      <section className="bg-[#f9f9f9] py-20 lg:py-28">
        <div className="mx-auto max-w-[760px] px-6 text-center">
          <h2 className="text-[clamp(1.9rem,4vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
            What Zavi drafts for {c.name}
          </h2>
          <p className="mx-auto mt-4 max-w-[62ch] text-[16px] leading-relaxed text-[#595959]">
            Shown for an example brand. Every post is a draft you approve. Never a surprise that&#x27;s
            already live.
          </p>
        </div>
        <div className="group mt-12 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]">
          <div className="flex w-max gap-5 [animation:zavi-ch-marquee_50s_linear_infinite] group-hover:[animation-play-state:paused]">
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Cold brew season is officially here ☕ Grab any large for the price of a small, all week, in
                every store.
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/coldbrew.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                New drop: our reusable cups just landed in three new colours. Tag a friend who needs one 💚
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/cups.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                “I got my mornings back.” See why locals made the switch.
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/team.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Weekend flash sale: 25% off everything in-store, Saturday only. Set your alarm ⏰
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/sale.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Behind the counter: meet the team that makes your morning happen ☀️
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/counter.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Refer a friend and you both get a free drink. Simple as that 🤝
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/gift.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Cold brew season is officially here ☕ Grab any large for the price of a small, all week, in
                every store.
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/coldbrew.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                New drop: our reusable cups just landed in three new colours. Tag a friend who needs one 💚
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/cups.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                “I got my mornings back.” See why locals made the switch.
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/team.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Weekend flash sale: 25% off everything in-store, Saturday only. Set your alarm ⏰
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/sale.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Behind the counter: meet the team that makes your morning happen ☀️
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/counter.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
            <article className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-black/[0.08] bg-white">
              <header className="flex items-center gap-3 p-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#f9f9f9] text-[14px] font-bold text-[#0e0f11]">
                  B
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-[#0e0f11]">Bloom &amp; Co.</p>
                  <p className="text-[13px] text-[#595959]">@bloomandco · Sponsored</p>
                </div>
                <span
                  className="ml-auto flex size-7 items-center justify-center rounded-[9px] bg-[#f9f9f9] [&>svg]:size-4"
                  title={c.name}
                >
                  {icon}
                </span>
              </header>
              <p className="px-4 pb-3 text-[14px] leading-relaxed text-[#1f1f1f]">
                Refer a friend and you both get a free drink. Simple as that 🤝
              </p>
              <div className="mx-4 aspect-[5/3] overflow-hidden rounded-2xl bg-[#f9f9f9]">
                <img
                  src="/marketing/growth-home/channel-posts/gift.jpg"
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
              <footer className="mt-auto flex items-center gap-4 p-4">
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#f5faf8] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-[#167f50]">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="lucide lucide-check size-3.5"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>{" "}
                  Example draft
                </span>
              </footer>
            </article>
          </div>
        </div>
      </section>
      <section className="bg-white px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-[1280px] overflow-hidden rounded-blockLg bg-[#0e0f11] px-6 py-20 text-center text-white lg:py-28">
          <p className="text-[16px] font-semibold tracking-[0.14em] text-white/50 uppercase">
            One agent, every channel
          </p>
          <h2
            className={`${jakartaHeavy.className} mx-auto mt-4 max-w-[16ch] text-[clamp(2.2rem,4.6vw,3.5rem)] leading-[1.05] font-extrabold tracking-[-0.03em]`}
          >
            Let AI grow your business
          </h2>
          <p className="mx-auto mt-5 max-w-[46ch] text-[20px] leading-relaxed text-white/70">
            Agents that find what to fix in your ads, SEO, and landing pages, draft the change, and wait for your approval.
          </p>
          <div className="[&>form]:mx-auto [&>form]:text-center">{ctaForm}</div>
          <ul className="mx-auto mt-10 flex max-w-[720px] flex-wrap justify-center gap-2">
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  stroke="currentColor"
                  fill="currentColor"
                  strokeWidth="0"
                  role="img"
                  viewBox="0 0 24 24"
                  className="h-5 w-5 text-[#FF4500]"
                  height="1em"
                  width="1em"
                >
                  <path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" />
                </svg>
              </span>
              Reddit
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-search h-5 w-5 text-[#0e0f11]"
                  aria-hidden="true"
                >
                  <path d="m21 21-4.34-4.34" />
                  <circle cx="11" cy="11" r="8" />
                </svg>
              </span>
              SEO
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-sparkles h-5 w-5 text-[#0e0f11]"
                  aria-hidden="true"
                >
                  <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
                  <path d="M20 2v4" />
                  <path d="M22 4h-4" />
                  <circle cx="4" cy="20" r="2" />
                </svg>
              </span>
              GEO (AI search)
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  stroke="currentColor"
                  fill="currentColor"
                  strokeWidth="0"
                  role="img"
                  viewBox="0 0 24 24"
                  className="h-4 w-4 text-[#0e0f11]"
                  height="1em"
                  width="1em"
                >
                  <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
                </svg>
              </span>
              X
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  stroke="currentColor"
                  fill="currentColor"
                  strokeWidth="0"
                  role="img"
                  viewBox="0 0 24 24"
                  className="h-5 w-5 text-[#E1306C]"
                  height="1em"
                  width="1em"
                >
                  <path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" />
                </svg>
              </span>
              Instagram
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  stroke="currentColor"
                  fill="currentColor"
                  strokeWidth="0"
                  viewBox="0 0 448 512"
                  className="h-5 w-5 text-[#0A66C2]"
                  height="1em"
                  width="1em"
                >
                  <path d="M416 32H31.9C14.3 32 0 46.5 0 64.3v383.4C0 465.5 14.3 480 31.9 480H416c17.6 0 32-14.5 32-32.3V64.3c0-17.8-14.4-32.3-32-32.3zM135.4 416H69V202.2h66.5V416zm-33.2-243c-21.3 0-38.5-17.3-38.5-38.5S80.9 96 102.2 96c21.2 0 38.5 17.3 38.5 38.5 0 21.3-17.2 38.5-38.5 38.5zm282.1 243h-66.4V312c0-24.8-.5-56.7-34.5-56.7-34.6 0-39.9 27-39.9 54.9V416h-66.4V202.2h63.7v29.2h.9c8.9-16.8 30.6-34.5 62.9-34.5 67.2 0 79.7 44.3 79.7 101.9V416z" />
                </svg>
              </span>
              LinkedIn Ads
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-video h-5 w-5 text-[#0e0f11]"
                  aria-hidden="true"
                >
                  <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
                  <rect x="2" y="6" width="14" height="12" rx="2" />
                </svg>
              </span>
              UGC
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-mail h-5 w-5 text-[#0e0f11]"
                  aria-hidden="true"
                >
                  <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                </svg>
              </span>
              Email
            </li>
            <li className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 text-[16px] font-medium">
              <span className="flex size-5 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&_.text-\[\#0e0f11\]]:text-white">
                <svg
                  stroke="currentColor"
                  fill="currentColor"
                  strokeWidth="0"
                  role="img"
                  viewBox="0 0 24 24"
                  className="h-5 w-5 text-[#0064E0]"
                  height="1em"
                  width="1em"
                >
                  <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
                </svg>
              </span>
              Meta Ads
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
