
export class ExprError extends Error {
  constructor(
    public readonly code: "parse_error" | "unknown_name" | "division_by_zero" | "not_finite" | "too_long",
    message: string,
  ) {
    super(message);
    this.name = "ExprError";
  }
}

export const MAX_EXPR_LENGTH = 500;
const MAX_DEPTH = 50;

export function pctChange(oldV: number, newV: number): number {
  if (oldV === 0) throw new ExprError("division_by_zero", "pct_change from 0 is undefined.");
  return ((newV - oldV) / Math.abs(oldV)) * 100;
}

export function ppChange(oldV: number, newV: number): number {
  return (newV - oldV) * 100;
}

const FUNCS: Record<string, (a: number, b: number) => number> = {
  pct_change: pctChange,
  pp_change: ppChange,
  ratio: (a, b) => {
    if (b === 0) throw new ExprError("division_by_zero", "ratio with a zero denominator is undefined.");
    return a / b;
  },
};

type Tok =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" | "," };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      out.push({ t: "op", v: c as Extract<Tok, { t: "op" }>["v"] });
      i++;
      continue;
    }
    const num = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0] });
      i += name[0].length;
      continue;
    }
    throw new ExprError("parse_error", `Unexpected character '${c}' at position ${i}. Only numbers, input names, + - * / ( ) and pct_change / pp_change / ratio are allowed.`);
  }
  return out;
}

export function expressionLiterals(expression: string): number[] {
  return tokenize(expression)
    .filter((t): t is Extract<Tok, { t: "num" }> => t.t === "num")
    .map((t) => t.v);
}

export function evaluate(expression: string, vars: Record<string, number>): number {
  if (typeof expression !== "string" || expression.trim() === "") throw new ExprError("parse_error", "Empty expression.");
  if (expression.length > MAX_EXPR_LENGTH) throw new ExprError("too_long", `Expression is over ${MAX_EXPR_LENGTH} characters.`);
  const toks = tokenize(expression);
  let pos = 0;
  let depth = 0;

  const peek = () => toks[pos];
  const isOp = (v: string) => {
    const t = peek();
    return t?.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError("parse_error", `Expected '${v}' at token ${pos + 1}.`);
    pos++;
  };

  function expr(): number {
    if (++depth > MAX_DEPTH) throw new ExprError("parse_error", "Expression is nested too deeply.");
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[pos++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    depth--;
    return v;
  }
  function term(): number {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = (toks[pos++] as { v: string }).v;
      const r = unary();
      if (op === "/") {
        if (r === 0) throw new ExprError("division_by_zero", "Division by zero.");
        v = v / r;
      } else v = v * r;
    }
    return v;
  }
  function unary(): number {
    if (isOp("-")) {
      pos++;
      if (++depth > MAX_DEPTH) throw new ExprError("parse_error", "Expression is nested too deeply.");
      const v = -unary();
      depth--;
      return v;
    }
    return primary();
  }
  function primary(): number {
    const t = peek();
    if (!t) throw new ExprError("parse_error", "Expression ended early.");
    if (t.t === "num") {
      pos++;
      return t.v;
    }
    if (t.t === "name") {
      pos++;
      if (isOp("(")) {
        const fn = Object.prototype.hasOwnProperty.call(FUNCS, t.v) ? FUNCS[t.v] : undefined;
        if (!fn) throw new ExprError("parse_error", `Unknown function '${t.v}'. Allowed: pct_change, pp_change, ratio.`);
        pos++;
        const a = expr();
        expect(",");
        const b = expr();
        expect(")");
        return fn(a, b);
      }
      if (!Object.prototype.hasOwnProperty.call(vars, t.v)) {
        throw new ExprError("unknown_name", `'${t.v}' is not one of the inputs.`);
      }
      return vars[t.v];
    }
    if (t.v === "(") {
      pos++;
      const v = expr();
      expect(")");
      return v;
    }
    throw new ExprError("parse_error", `Unexpected '${t.v}' at token ${pos + 1}.`);
  }

  const v = expr();
  if (pos !== toks.length) throw new ExprError("parse_error", `Unexpected input after token ${pos}.`);
  if (!Number.isFinite(v)) throw new ExprError("not_finite", "The result is not a finite number.");
  return v;
}
