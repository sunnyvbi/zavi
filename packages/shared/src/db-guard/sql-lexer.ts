
export type SqlDialect = "postgres" | "mysql";

export type Token = {
  kind: "ident" | "keyword" | "punct" | "number" | "param";
  value: string;
  quoted: boolean;
  next?: string;
  start: number;
  end: number;
};

export type LexResult = { tokens: Token[]; unsafe: string | null };

const KEYWORDS = new Set(
  (
    "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET UNION INTERSECT EXCEPT ALL DISTINCT AS ON USING " +
    "JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL LATERAL WITH RECURSIVE AND OR NOT IN IS NULL LIKE ILIKE " +
    "BETWEEN CASE WHEN THEN ELSE END EXISTS ASC DESC NULLS FIRST LAST WINDOW OVER PARTITION ROWS RANGE " +
    "PRECEDING FOLLOWING UNBOUNDED CURRENT ROW FETCH NEXT ONLY FOR TRUE FALSE ANY SOME FILTER WITHIN " +
    "INTERVAL SIMILAR ESCAPE COLLATE STRAIGHT_JOIN TABLE"
  ).split(/\s+/),
);

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const WS = /[ \t\n\r\f\v]/;

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word.toUpperCase());
}

export function lexSql(sql: string, dialect: SqlDialect): LexResult {
  const toks: Token[] = [];
  let unsafe: string | null = null;
  let i = 0;
  const n = sql.length;
  const push = (t: Omit<Token, "next">) => toks.push(t);

  const readQuoted = (q: string): { text: string; end: number; terminated: boolean } => {
    let j = i + 1;
    let text = "";
    while (j < n) {
      if (sql[j] === q && sql[j + 1] === q) {
        text += q;
        j += 2;
        continue;
      }
      if (sql[j] === q) return { text, end: j + 1, terminated: true };
      text += sql[j];
      j++;
    }
    return { text, end: n, terminated: false };
  };

  while (i < n) {
    const c = sql[i]!;
    const c2 = sql[i + 1];
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c.charCodeAt(0) >= 0x80 || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) {
      unsafe ??= "Non-ASCII or control characters outside quotes are not supported. Use plain ASCII names and spaces.";
      i++;
      continue;
    }
    if (
      c === "-" &&
      c2 === "-" &&
      (dialect === "postgres" || i + 2 >= n || /[\x00-\x20\x7f]/.test(sql[i + 2]!))
    ) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (dialect === "mysql" && c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      if (dialect === "mysql" && (sql[i + 2] === "!" || sql[i + 2] === "+")) unsafe ??= "MySQL executable comments are not allowed.";
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (dialect === "postgres" && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) unsafe ??= "Unterminated comment.";
      continue;
    }
    if (c === "'") {
      const r = readQuoted("'");
      if (!r.terminated) unsafe ??= "Unterminated string literal.";
      if (r.text.includes("\\")) unsafe ??= "Backslashes inside string literals are not supported. Rewrite the literal without a backslash.";
      i = r.end;
      continue;
    }
    if (c === '"' || c === "`") {
      const r = readQuoted(c);
      if (!r.terminated) unsafe ??= "Unterminated quoted identifier.";
      if (dialect === "mysql" && c === '"' && r.text.includes("\\")) {
        unsafe ??= "Backslashes inside double-quoted text are not supported on MySQL.";
      }
      push({ kind: "ident", value: r.text, quoted: true, start: i, end: r.end });
      i = r.end;
      continue;
    }
    if (c === "$" && dialect === "postgres") {
      const p = /^\$(\d+)/.exec(sql.slice(i));
      if (p) {
        push({ kind: "param", value: p[0], quoted: false, start: i, end: i + p[0].length });
        i += p[0].length;
        continue;
      }
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end === -1) {
          unsafe ??= "Unterminated dollar-quoted string.";
          i = n;
        } else i = end + m[0].length;
        continue;
      }
    }
    if (c === "?" && dialect === "mysql") {
      push({ kind: "param", value: "?", quoted: false, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && c2 !== undefined && /[0-9]/.test(c2))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(sql.slice(i))!;
      let j = i + m[0].length;
      if (j < n && IDENT_PART.test(sql[j]!) && sql[j] !== "$") {
        j = i;
        while (j < n && IDENT_PART.test(sql[j]!)) j++;
        const word = sql.slice(i, j);
        push({ kind: "ident", value: word, quoted: false, start: i, end: j });
      } else {
        push({ kind: "number", value: m[0], quoted: false, start: i, end: j });
      }
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < n && IDENT_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      if (sql[j] === "'" && /^[EeNnBbXx]$/.test(word)) {
        i = j;
        continue;
      }
      if (/^[Uu]$/.test(word) && sql[j] === "&" && (sql[j + 1] === "'" || sql[j + 1] === '"')) {
        unsafe ??= "U& escaped literals are not supported.";
        i = j + 1;
        continue;
      }
      if (KEYWORDS.has(word.toUpperCase())) push({ kind: "keyword", value: word.toUpperCase(), quoted: false, start: i, end: j });
      else push({ kind: "ident", value: word, quoted: false, start: i, end: j });
      i = j;
      continue;
    }
    if (c === ":" && c2 === ":") {
      push({ kind: "punct", value: "::", quoted: false, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === "@" && dialect === "mysql") {
      unsafe ??= "Server or session variables (@x) are not allowed.";
    }
    push({ kind: "punct", value: c, quoted: false, start: i, end: i + 1 });
    i++;
  }
  for (let k = 0; k < toks.length; k++) {
    const nx = toks[k + 1];
    if (nx) toks[k]!.next = nx.kind === "punct" ? nx.value[0] : nx.value[0];
  }
  return { tokens: toks, unsafe };
}
