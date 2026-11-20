"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import dynamic from "next/dynamic";
import { inter } from "@/fonts";

const HeroAgentDemo = dynamic(
  () => import("./HeroAgentDemo").then((m) => m.HeroAgentDemo),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[440px] w-full rounded-3xl border border-neutral-200 bg-white/60 shadow-2xl shadow-neutral-300/40 backdrop-blur-md" />
    ),
  },
);

function GridBg() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(0,0,0,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.07) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(ellipse 80% 60% at 50% 30%, black 40%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 60% at 50% 30%, black 40%, transparent 100%)",
        }}
      />
    </div>
  );
}

function GlowOrbs() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
      <motion.div
        animate={{ x: [0, 40, 0], y: [0, -20, 0] }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-[-10%] left-[10%] w-[500px] h-[500px] rounded-full blur-3xl opacity-40 bg-neutral-200"
      />
      <motion.div
        animate={{ x: [0, -30, 0], y: [0, 30, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-[20%] right-[5%] w-[600px] h-[600px] rounded-full blur-3xl opacity-50 bg-neutral-200"
      />
    </div>
  );
}

function Particles({ count = 28 }: { count?: number }) {
  const [items, setItems] = useState<
    { x: number; y: number; d: number; s: number }[]
  >([]);

  useEffect(() => {
    setItems(
      Array.from({ length: count }).map(() => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        d: 8 + Math.random() * 14,
        s: 2 + Math.random() * 4,
      })),
    );
  }, [count]);

  return (
    <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
      {items.map((p, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.s,
            height: p.s,
            background: "#171717",
            boxShadow: `0 0 ${p.s * 3}px #171717`,
          }}
          animate={{ y: [0, -40, 0], x: [0, 20, 0], opacity: [0.2, 0.9, 0.2] }}
          transition={{
            duration: p.d,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.2,
          }}
        />
      ))}
    </div>
  );
}

export function HeroFuturistic() {
  return (
    <section
      className={`${inter.variable} relative overflow-hidden bg-[#f5f3f1] text-neutral-900 antialiased`}
    >
      <GridBg />
      <GlowOrbs />
      <Particles count={28} />
      <div className="relative mx-auto max-w-[1240px] px-6 md:px-10 pt-20 pb-28">
        <div className="grid lg:grid-cols-[1.55fr_1fr] gap-12 items-center">
          {}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mb-6 inline-flex h-[30px] items-center gap-2 rounded-full border border-[#e5e5e5] bg-white/60 px-3 shadow-[0px_1px_3px_0px_rgba(0,0,0,0.1),0px_1px_2px_0px_rgba(0,0,0,0.1)] backdrop-blur-md"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 rounded-full bg-[#171717] animate-ping opacity-75" />
                <span className="relative h-2 w-2 rounded-full bg-[#171717]" />
              </span>
              <span className="font-[family-name:var(--font-inter)] text-[12px] uppercase leading-4 tracking-[0.6px] text-[#404040]">
                Autonomous AI Agent Fleet · Beta
              </span>
            </motion.div>

            {}
            <h1 className="whitespace-nowrap font-[family-name:var(--font-inter)] font-medium leading-[1.02] tracking-[-0.045em] text-[#171717] text-[clamp(2rem,5.6vw,5rem)]">
              The{" "}
              <span className="inline-block rounded-[6px] bg-[#171717] px-[0.16em] py-0 leading-[1.0] text-white">
                brain
              </span>{" "}
              that{" "}
              <span className="relative inline-block">
                <span className="italic">runs</span>
                <motion.span
                  className="absolute -bottom-1 left-0 right-0 h-[3px] bg-[#171717]"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ delay: 0.7, duration: 0.8 }}
                />
              </span>
              <br /> your company.
            </h1>

            <p className="mt-8 max-w-[576px] font-[family-name:var(--font-inter)] text-[20px] leading-[29.25px] tracking-[-0.44px] text-[#525252]">
              AI Growth Agent For Your Business. A full fleet of autonomous
              agents, pre-loaded. Connect Slack and Stripe. Ship from day one.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link
                href="/start"
                className="group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#171717] px-6 font-[family-name:var(--font-inter)] text-[16px] font-medium tracking-[-0.15px] text-white shadow-[0px_10px_7.5px_0px_rgba(23,23,23,0.2),0px_4px_3px_0px_rgba(23,23,23,0.2)] transition-colors hover:bg-[#404040]"
              >
                Start onboarding
                <img
                  src="/hero/arrow.svg"
                  alt=""
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            </div>

            <div className="mt-10 flex items-center gap-6">
              <div className="flex items-center gap-2 font-[family-name:var(--font-inter)] text-[12px] text-[#737373]">
                <img src="/hero/check.svg" alt="" className="h-3.5 w-3.5" />{" "}
                Per-tenant RLS isolation
              </div>
              <div className="flex items-center gap-2 font-[family-name:var(--font-inter)] text-[12px] text-[#737373]">
                <img src="/hero/check.svg" alt="" className="h-3.5 w-3.5" /> Your
                data stays yours
              </div>
              <div className="flex items-center gap-2 font-[family-name:var(--font-inter)] text-[12px] text-[#737373]">
                <img src="/hero/check.svg" alt="" className="h-3.5 w-3.5" /> SOC 2
                on the roadmap
              </div>
            </div>
          </motion.div>

          {}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.15 }}
            className="relative"
          >
            <HeroAgentDemo />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
