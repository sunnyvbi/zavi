export function sanitizeSvg(src: string): string | null {
  if (!/<svg[\s>]/i.test(src)) return null;
  return (
    src
      .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<script[^>]*\/?>/gi, "")
      .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
      .replace(/<foreignObject[^>]*\/?>/gi, "")
      .replace(/<(iframe|embed|object|link|meta|base)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(iframe|embed|object|link|meta|base)\b[^>]*\/?>/gi, "")
      .replace(/<(animate|set|animateTransform|animateMotion|animateColor)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(animate|set|animateTransform|animateMotion|animateColor)\b[^>]*\/?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\s(href|xlink:href|src)\s*=\s*("|')\s*(javascript|data|vbscript)\s*:[^"']*\2/gi, "")
      .replace(/\s(href|xlink:href|src)\s*=\s*(javascript|data|vbscript)\s*:[^\s>]*/gi, "")
  );
}
