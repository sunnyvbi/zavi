"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const ART_VERSION = "2";
type OneShot = "poke" | "celebrate";
const base = (name: string) => `/mascots/video/zavi-${name}`;
const STILL = `/mascots/video/zavi-still.webp?v=${ART_VERSION}`;

function Sources({ name }: { name: string }) {
  return (
    <>
      <source src={`${base(name)}.mov?v=${ART_VERSION}`} type='video/quicktime; codecs="hvc1"' />
      <source src={`${base(name)}.webm?v=${ART_VERSION}`} type="video/webm" />
    </>
  );
}

export const MASCOT_VIDEO_MIN_SIZE = 48;

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  mq?.addEventListener?.("change", cb);
  return () => mq?.removeEventListener?.("change", cb);
}
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export type ZaviMascotProps = {
  size?: number;
  className?: string;
  working?: boolean;
  celebrate?: number;
};

export function ZaviMascot({ size = 140, className, working = false, celebrate = 0 }: ZaviMascotProps) {
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => true);
  const [oneShot, setOneShot] = useState<{ name: OneShot; n: number } | null>(null);
  const [oneShotVisible, setOneShotVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const lastCelebrate = useRef(celebrate);

  const animated = size >= MASCOT_VIDEO_MIN_SIZE && !reduced && !failed;

  useEffect(() => {
    if (celebrate > lastCelebrate.current && animated) {
      setOneShotVisible(false);
      setOneShot((o) => ({ name: "celebrate", n: (o?.n ?? 0) + 1 }));
    }
    lastCelebrate.current = celebrate;
  }, [celebrate, animated]);

  const endOneShot = () => {
    setOneShot(null);
    setOneShotVisible(false);
  };
  const poke = () => {
    if (!animated || oneShot) return;
    setOneShotVisible(false);
    setOneShot({ name: "poke", n: 0 });
  };

  const box = { width: size, height: size };

  if (!animated) {
    return (
      <span aria-hidden="true" className={`relative inline-block shrink-0 ${className ?? ""}`} style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={STILL} alt="" width={size} height={size} draggable={false} className="block h-full w-full" />
      </span>
    );
  }

  const loop = working ? "working" : "idle";
  return (
    <span
      aria-hidden="true"
      data-testid="zavi-mascot"
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={box}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") poke();
      }}
      onClick={poke}
    >
      <video
        key={loop}
        data-clip={loop}
        poster={STILL}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        tabIndex={-1}
        className="block h-full w-full"
        style={{ opacity: oneShotVisible ? 0 : 1 }}
      >
        <Sources name={loop} />
        {}
        <source src="data:," onError={() => setFailed(true)} />
      </video>
      {oneShot ? (
        <video
          key={`${oneShot.name}-${oneShot.n}`}
          data-testid={`zavi-mascot-${oneShot.name}`}
          autoPlay
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          tabIndex={-1}
          onCanPlay={(e) => void e.currentTarget.play()?.catch(endOneShot)}
          onPlaying={() => setOneShotVisible(true)}
          onEnded={endOneShot}
          className="absolute inset-0 block h-full w-full"
          style={{ opacity: oneShotVisible ? 1 : 0 }}
        >
          <Sources name={oneShot.name} />
          <source src="data:," onError={endOneShot} />
        </video>
      ) : null}
    </span>
  );
}

export default ZaviMascot;
