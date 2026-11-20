
const WHITESPACE_ENTITY = /&#(?:x0*(?:9|a|d|20)|0*(?:9|10|13|32));/gi;
const PATH_ATTR = /\s(d|points)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const LOWER_CMDS = "mzlhvcsqta";
const FLOAT_MAX = 3.4028234663852886e38;
const CSS_VAR = /var\(\s*--[\w-]+\s*,\s*([^()]+?)\s*\)/g;
const PERCENT_RGB = /rgb\(\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/g;
const ROOT_SVG_TAG = /<svg\b[^>]*>/i;
const TRANSFORM = /\stransform\s*=|transform\s*:/i;

export function isDrawablePath(d: string): boolean {
  const l = d.length;
  let i = 0;
  const isSpace = (c: string) => /\s/.test(c);
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const skipSpaces = () => {
    while (i < l && isSpace(d[i])) i++;
  };
  const skipDigits = () => {
    while (i < l && isDigit(d[i])) i++;
  };
  const number = (): boolean => {
    skipSpaces();
    if (i >= l) return false;
    const start = i;
    if (d[i] === "-" || d[i] === "+") {
      i++;
      if (i >= l) return false;
    }
    if (isDigit(d[i])) skipDigits();
    else if (d[i] !== ".") return false;
    if (d[i] === ".") {
      i++;
      skipDigits();
    }
    if ((d[i] === "e" || d[i] === "E") && i + 1 < l && d[i + 1] !== "m" && d[i + 1] !== "x") {
      i++;
      if (d[i] === "+" || d[i] === "-") i++;
      else if (!isDigit(d[i])) return false;
      skipDigits();
    }
    const n = Number(d.slice(start, i));
    if (!Number.isFinite(n) || Math.abs(n) > FLOAT_MAX) return false;
    skipSpaces();
    if (d[i] === ",") i++;
    return true;
  };
  const flag = (): boolean => {
    skipSpaces();
    if (d[i] !== "0" && d[i] !== "1") return false;
    i++;
    if (d[i] === ",") i++;
    skipSpaces();
    return true;
  };
  const numbers = (count: number) => {
    for (let k = 0; k < count; k++) if (!number()) return false;
    return true;
  };

  let prev = "";
  while (i < l) {
    skipSpaces();
    if (i >= l) break;
    const c = d[i];
    if (!prev && c !== "M" && c !== "m") return false;
    let cmd: string;
    if (LOWER_CMDS.includes(c.toLowerCase())) {
      cmd = c;
      i++;
    } else if (prev && (isDigit(c) || c === "." || c === "-" || c === "+")) {
      if (prev === "z" || prev === "Z") return false;
      cmd = prev === "M" ? "L" : prev === "m" ? "l" : prev;
    } else {
      return false;
    }
    switch (cmd.toLowerCase()) {
      case "m":
      case "l":
      case "t":
        if (!numbers(2)) return false;
        break;
      case "h":
      case "v":
        if (!numbers(1)) return false;
        break;
      case "c":
        if (!numbers(6)) return false;
        break;
      case "s":
      case "q":
        if (!numbers(4)) return false;
        break;
      case "a":
        if (!numbers(3) || !flag() || !flag() || !numbers(2)) return false;
        break;
    }
    prev = LOWER_CMDS.includes(c.toLowerCase()) ? c : prev === "M" || prev === "m" ? prev : cmd;
  }
  return true;
}

function pointsAsPath(points: string): string {
  return `M${points.replace(/[^eE]-/, " -").split(/(?:\s+|\s*,\s*)/g).join(" ")}z`;
}

function nativeColors(xml: string): string {
  return xml
    .replace(CSS_VAR, "$1")
    .replace(PERCENT_RGB, (_, r, g, b) => `rgb(${[r, g, b].map((p) => Math.round(Number(p) * 2.55)).join(",")})`);
}

export function drawableLogoSvg(xml: string | null | undefined): string | null {
  if (!xml || !/<svg[\s>]/i.test(xml)) return null;
  const clean = nativeColors(xml.replace(WHITESPACE_ENTITY, " "));
  if (TRANSFORM.test(clean.match(ROOT_SVG_TAG)?.[0] ?? "")) return null;
  for (const m of clean.matchAll(PATH_ATTR)) {
    const value = m[2] ?? m[3] ?? "";
    if (!value.trim()) continue;
    if (!isDrawablePath(m[1] === "points" ? pointsAsPath(value) : value)) return null;
  }
  return clean;
}
