

import { utf8Bytes } from "./sha256";
import type { CollectionSchema, PropertySchema } from "./manifest";

export type Member = { userId: string; role: string | null } | null;

export type FunctionCaller = { fn: string; asAdmin: boolean } | null;

export function principalMatch(principals: unknown, member: Member, owner: string | null, recipient: string | null = null, fn: FunctionCaller = null): boolean {
  if (!Array.isArray(principals)) return false;
  if (fn !== null) return principals.some((p) => p === `fn:${fn.fn}` || (fn.asAdmin && p === "admin"));
  return principals.some((p) =>
    p === "anyone" ||
    (member !== null && (
      p === "signed_in" ||
      (p === "owner" && owner !== null && owner === member.userId) ||
      (p === "recipient" && recipient !== null && recipient === member.userId) ||
      (member.role !== null && p === "admin" && member.role === "admin") ||
      (member.role !== null && p === `role:${member.role}`)
    )));
}

export class DocError extends Error {
  readonly reason: string;
  constructor(message: string) {
    super(`schema_violation: ${message}`);
    this.name = "DocError";
    this.reason = this.message;
  }
}

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{1,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= days;
}

export function isPgDate(s: string): boolean {
  const m = DATE.exec(s);
  return !!m && validDate(+m[1], +m[2], +m[3]);
}

export function isPgDateTime(s: string): boolean {
  const m = DATE_TIME.exec(s);
  if (!m || !validDate(+m[1], +m[2], +m[3])) return false;
  const [hh, mi, ss] = [+m[4], +m[5], m[6] === undefined ? 0 : +m[6]];
  if (hh > 24 || mi > 59 || ss > 60 || (hh === 24 && (mi > 0 || ss > 0))) return false;
  if (m[7] !== undefined && (+m[7] > 15 || +m[8] > 59)) return false;
  return true;
}

const charLength = (s: string) => [...s].length;

export function validateValue(key: string, p: PropertySchema, v: unknown): void {
  switch (p.type) {
    case "string": {
      if (typeof v !== "string") throw new DocError(`${key} must be a string`);
      if (charLength(v) > p.maxLength) throw new DocError(`${key} is longer than ${p.maxLength}`);
      if (p.minLength !== undefined && charLength(v) < p.minLength) throw new DocError(`${key} is shorter than ${p.minLength}`);
      if (p.enum !== undefined && !p.enum.includes(v)) throw new DocError(`${key} is not an allowed value`);
      if (p.format === "email" && !EMAIL.test(v)) throw new DocError(`${key} is not an email`);
      if (p.format === "date" && !isPgDate(v)) throw new DocError(`${key} is not a date`);
      if (p.format === "date-time" && !isPgDateTime(v)) throw new DocError(`${key} is not a date-time`);
      if (p.format === "uuid" && !UUID.test(v.toLowerCase())) throw new DocError(`${key} is not a uuid`);
      return;
    }
    case "integer":
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new DocError(`${key} must be a number`);
      if (p.type === "integer" && !Number.isInteger(v)) throw new DocError(`${key} must be an integer`);
      if (p.minimum !== undefined && v < p.minimum) throw new DocError(`${key} is below the minimum`);
      if (p.maximum !== undefined && v > p.maximum) throw new DocError(`${key} is above the maximum`);
      return;
    }
    case "boolean":
      if (typeof v !== "boolean") throw new DocError(`${key} must be a boolean`);
      return;
    case "array": {
      if (!Array.isArray(v)) throw new DocError(`${key} must be an array`);
      if (v.length > p.maxItems) throw new DocError(`${key} has too many items`);
      for (const e of v) validateValue(`${key}[]`, p.items, e);
      return;
    }
    default:
      throw new DocError(`${key} has no valid type`);
  }
}

function hasNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (Array.isArray(v)) return v.some(hasNul);
  if (v !== null && typeof v === "object") return Object.entries(v).some(([k, x]) => k.includes("\u0000") || hasNul(x));
  return false;
}

export function validateDoc(schema: CollectionSchema, doc: unknown): void {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new DocError("document must be an object");
  if (hasNul(doc)) throw new DocError("text may not contain a NUL character");
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) throw new DocError(`unknown field ${k}`);
    validateValue(k, schema.properties[k], v);
  }
  for (const r of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(doc, r)) throw new DocError(`${r} is required`);
  }
}

function jsonbKeyOrder(a: string, b: string): number {
  const ba = utf8Bytes(a), bb = utf8Bytes(b);
  if (ba.length !== bb.length) return ba.length - bb.length;
  for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) return ba[i] - bb[i];
  return 0;
}

function jsonbString(s: string): string {
  return `"${s.replace(/[\u0000-\u001f"\\]/g, (c) => {
    switch (c) {
      case '"': return '\\"';
      case "\\": return "\\\\";
      case "\b": return "\\b";
      case "\f": return "\\f";
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      default: return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  })}"`;
}

export function jsonbText(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return jsonbString(v);
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort(jsonbKeyOrder).map((k) => `${jsonbString(k)}: ${jsonbText(o[k])}`).join(", ")}}`;
}

export function recordBytes(data: unknown): number {
  return utf8Bytes(jsonbText(data)).length;
}

export function fieldText(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  return jsonbText(v);
}
