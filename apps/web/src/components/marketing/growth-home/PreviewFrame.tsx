import type { CSSProperties, ReactNode } from "react";

export const PREVIEW_FRAME_MAX_W = "max-w-[720px]";
export const PREVIEW_FRAME_INNER_H = "h-[540px] sm:h-[580px]";

export function ZaviAvatar({ size, radius }: { size: number; radius: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/marketing/growth-home/zavi-app-icon.png"
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export function PreviewFrame({
  label,
  inner,
  style,
  children,
}: {
  label: string;
  inner: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`w-full ${PREVIEW_FRAME_MAX_W} rounded-[30px] border border-white bg-gradient-to-b from-[#f7f7fa] to-[#eeeef4] p-2.5 shadow-[0_32px_64px_-16px_rgba(26,24,43,0.18)]`}
      style={style}
    >
      <div className={`flex ${PREVIEW_FRAME_INNER_H} overflow-hidden rounded-[22px] border ${inner}`}>
        {children}
      </div>
    </div>
  );
}
