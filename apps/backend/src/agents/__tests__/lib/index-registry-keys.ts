
export type RegistryScan = {
  keys: Set<string>;
  unresolved: string[];
};

export function scanRegistry(
  src: string,
  declMarker: string,
  resolveIdentifier?: (name: string) => string | null,
): RegistryScan {
  const declStart = src.indexOf(declMarker);
  if (declStart === -1) {
    throw new Error(`topLevelRegistryKeys: could not find \`${declMarker}\``);
  }
  const open = src.indexOf("{", declStart + declMarker.length - 1);
  if (open === -1) {
    throw new Error(`topLevelRegistryKeys: no opening brace for \`${declMarker}\``);
  }

  const keys = new Set<string>();
  const unresolved: string[] = [];
  let depth = 0;
  let expectKey = false;
  let i = open;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      if (expectKey && depth === 1) {
        const close = src.indexOf(c, i + 1);
        keys.add(src.slice(i + 1, close));
        expectKey = false;
        i = close + 1;
        continue;
      }
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }

    if (c === "[" && expectKey && depth === 1) {
      const close = src.indexOf("]", i + 1);
      const inner = close === -1 ? "" : src.slice(i + 1, close).trim();
      let after = close + 1;
      while (after < src.length && /\s/.test(src[after])) after++;
      if (close !== -1 && /^[A-Za-z_$][\w$]*$/.test(inner) && src[after] === ":") {
        const lit = resolveIdentifier?.(inner) ?? null;
        if (lit) keys.add(lit);
        else unresolved.push(inner);
        expectKey = false;
        i = close + 1;
        continue;
      }
    }

    if (c === "{" || c === "(" || c === "[") {
      depth++;
      if (depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) break;
      i++;
      continue;
    }

    if (c === "," && depth === 1) {
      expectKey = true;
      i++;
      continue;
    }

    if (expectKey && depth === 1 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const ident = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === ":") {
        keys.add(ident);
        expectKey = false;
      }
      i = j;
      continue;
    }

    i++;
  }
  return { keys, unresolved };
}

export function topLevelRegistryKeys(
  src: string,
  declMarker: string,
  resolveIdentifier?: (name: string) => string | null,
): Set<string> {
  const { keys, unresolved } = scanRegistry(src, declMarker, resolveIdentifier);
  if (unresolved.length > 0) {
    throw new Error(
      `topLevelRegistryKeys(${declMarker}): unresolved computed key(s): ` +
        `${unresolved.join(", ")}. The scan is blind to those entries — ` +
        "supply a resolveIdentifier that can read their string literal.",
    );
  }
  return keys;
}

export function makeIndexConstResolver(
  indexSrc: string,
  indexDir: string,
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
): (name: string) => string | null {
  return (name: string): string | null => {
    const importRe = new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']`,
      "g",
    );
    for (const m of indexSrc.matchAll(importRe)) {
      const clause = m[1];
      const spec = m[2];
      const aliased = new RegExp(`([A-Za-z_$][\\w$]*)\\s+as\\s+${name}\\b`).exec(clause);
      const bare = new RegExp(`(?:^|,)\\s*${name}\\s*(?:,|$)`).test(clause);
      if (!aliased && !bare) continue;
      const exported = aliased ? aliased[1] : name;
      if (!spec.startsWith(".")) return null;
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const p = `${indexDir}/${spec}${ext}`.replace(/\/+/g, "/");
        if (!exists(p)) continue;
        const lit = new RegExp(
          `export\\s+const\\s+${exported}\\s*(?::[^=]+)?=\\s*["']([^"']+)["']`,
        ).exec(readFile(p));
        if (lit) return lit[1];
      }
      return null;
    }
    return null;
  };
}

export function frontmatter(agentMd: string): string {
  const first = agentMd.indexOf("---");
  if (first === -1) return "";
  const second = agentMd.indexOf("\n---", first + 3);
  return second === -1 ? agentMd : agentMd.slice(first + 3, second);
}
