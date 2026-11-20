import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  aggregateHits,
  LogPayloadError,
  MAX_KEYS,
  normalizePath,
  OTHER_PATH,
  parseLogBody,
  parseTimestamp,
} from "../parse";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const OAI = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot";
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

describe("parseLogBody — the formats hosts actually push", () => {
  it("Cloudflare Logpush: gzipped NDJSON with nanosecond timestamps", () => {
    const ndjson = [
      { ClientRequestUserAgent: OAI, ClientRequestPath: "/pricing", EdgeResponseStatus: 200, EdgeStartTimestamp: 1789560000000000000 },
      { ClientRequestUserAgent: HUMAN, ClientRequestPath: "/", EdgeResponseStatus: 200, EdgeStartTimestamp: 1789560000000000000 },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    const { records } = parseLogBody(gzipSync(Buffer.from(ndjson)));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ userAgent: OAI, path: "/pricing", status: 200 });
    expect(new Date(records[0].ts!).toISOString()).toBe("2026-09-16T12:00:00.000Z");
  });

  it("Vercel log drain: JSON array with proxy.* and a millisecond timestamp", () => {
    const body = JSON.stringify([
      { timestamp: 1789560000000, proxy: { userAgent: [OAI], path: "/blog?x=1", statusCode: 403 } },
    ]);
    const { records } = parseLogBody(Buffer.from(body));
    expect(records[0]).toMatchObject({ userAgent: OAI, path: "/blog?x=1", status: 403, ts: 1789560000000 });
  });

  it("nginx/Apache combined access-log lines", () => {
    const line = `203.0.113.9 - - [16/Sep/2026:12:00:00 +0000] "GET /docs/start?ref=a HTTP/1.1" 200 5120 "-" "${OAI}"`;
    const { records, unparsed } = parseLogBody(Buffer.from(`${line}\nnot a log line\n`));
    expect(records).toHaveLength(1);
    expect(unparsed).toBe(1);
    expect(records[0]).toMatchObject({ path: "/docs/start?ref=a", status: 200, userAgent: OAI });
    expect(new Date(records[0].ts!).toISOString()).toBe("2026-09-16T12:00:00.000Z");
  });

  it("refuses an empty body and a gzip bomb", () => {
    expect(() => parseLogBody(Buffer.alloc(0))).toThrow(LogPayloadError);
    const bomb = gzipSync(Buffer.alloc(70 * 1024 * 1024, 0x61));
    try {
      parseLogBody(bomb);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LogPayloadError);
      expect((e as LogPayloadError).code).toBe("too_large");
    }
  });
});

describe("parseTimestamp", () => {
  it("sizes a numeric timestamp to its unit", () => {
    const iso = "2026-09-16T12:00:00.000Z";
    expect(new Date(parseTimestamp(1789560000)!).toISOString()).toBe(iso);
    expect(new Date(parseTimestamp(1789560000000)!).toISOString()).toBe(iso);
    expect(new Date(parseTimestamp(1789560000000000)!).toISOString()).toBe(iso);
    expect(new Date(parseTimestamp(1789560000000000000)!).toISOString()).toBe(iso);
    expect(new Date(parseTimestamp("2026-09-16T12:00:00Z")!).toISOString()).toBe(iso);
    expect(parseTimestamp("garbage")).toBeNull();
  });
});

describe("normalizePath", () => {
  it("keeps the path only", () => {
    expect(normalizePath("https://example.com/a/b?utm=1#x")).toBe("/a/b");
    expect(normalizePath("/pricing?plan=pro")).toBe("/pricing");
    expect(normalizePath("pricing")).toBe("/pricing");
    expect(normalizePath(null)).toBe("/");
  });
});

describe("aggregateHits — counts, and nothing else", () => {
  it("keeps named AI bots only, one row per day/bot/path/status", () => {
    const t = Date.parse("2026-09-16T08:00:00Z");
    const { rows, matched, ignored } = aggregateHits(
      [
        { ts: t, userAgent: OAI, path: "/pricing?a=1", status: 200 },
        { ts: t + 3600_000, userAgent: OAI, path: "/pricing?b=2", status: 200 },
        { ts: t, userAgent: OAI, path: "/pricing", status: 403 },
        { ts: t, userAgent: HUMAN, path: "/", status: 200 },
      ],
      NOW,
    );
    expect(matched).toBe(3);
    expect(ignored).toBe(1);
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.status === 200)!;
    expect(ok).toMatchObject({ day: "2026-09-16", bot: "OAI-SearchBot", path: "/pricing", hits: 2 });
    expect(ok.first_seen_at).toBe("2026-09-16T08:00:00.000Z");
    expect(ok.last_seen_at).toBe("2026-09-16T09:00:00.000Z");
    expect(Object.keys(ok).sort()).toEqual(["bot", "day", "first_seen_at", "hits", "last_seen_at", "path", "status"]);
  });

  it("counts an undated line on the day it arrived rather than dropping it", () => {
    const { rows, undated } = aggregateHits([{ ts: null, userAgent: OAI, path: "/", status: 200 }], NOW);
    expect(undated).toBe(1);
    expect(rows[0].day).toBe("2026-09-17");
  });

  it("folds paths past the key budget into (other) instead of growing without bound", () => {
    const records = Array.from({ length: MAX_KEYS + 50 }, (_, i) => ({ ts: NOW, userAgent: OAI, path: `/p/${i}`, status: 200 }));
    const { rows } = aggregateHits(records, NOW);
    expect(rows.length).toBe(MAX_KEYS + 1);
    expect(rows.find((r) => r.path === OTHER_PATH)!.hits).toBe(50);
  });
});
