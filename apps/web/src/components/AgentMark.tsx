
type Props = {
  slug: string;
  size?: number;
  className?: string;
  label?: string;
};

export function AgentMark({ slug, size = 24, className = "", label }: Props) {
  const url = `url(/agents/${slug}.svg)`;
  return (
    <span
      role="img"
      aria-label={label ?? slug}
      className={`inline-block bg-current shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: url,
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        WebkitMaskSize: "contain",
        maskImage: url,
        maskRepeat: "no-repeat",
        maskPosition: "center",
        maskSize: "contain",
      }}
    />
  );
}
