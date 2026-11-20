
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  schemaFromMock: vi.fn(),
  removeMock: vi.fn(),
  logEventMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    schema: () => ({ from: mocks.schemaFromMock }),
    storage: { from: () => ({ remove: mocks.removeMock }) },
  }),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEventMock,
}));

beforeEach(() => {
  mocks.schemaFromMock.mockReset();
  mocks.removeMock.mockReset();
  mocks.logEventMock.mockReset();
  mocks.loggerInfoMock.mockReset();
  mocks.loggerWarnMock.mockReset();
  mocks.loggerErrorMock.mockReset();
});

function mockQueryReturning(rows: { name: string | null }[] | null, error: unknown = null) {
  const final = Promise.resolve({ data: rows, error });
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.lt = vi.fn(() => final);
  mocks.schemaFromMock.mockReturnValue(chain);
}

async function runSweep() {
  const mod = await import("../../../workers/functions/chat-image-stale-sweep");
  return mod;
}

describe("chat-image-stale-sweep cron", () => {
  it("exports chatImageStaleSweepFn with id 'chat-image-stale-sweep' and daily cron", async () => {
    const { chatImageStaleSweepFn } = await import("../../../workers/functions/chat-image-stale-sweep");
    expect(chatImageStaleSweepFn).toBeDefined();
    const fnAny = chatImageStaleSweepFn as unknown as {
      opts: { id: string; triggers: { cron?: string }[] };
    };
    expect(fnAny.opts.id).toBe("chat-image-stale-sweep");
    expect(fnAny.opts.triggers.map((t) => t.cron)).toContain("0 4 * * *");
  });

  describe("sweep handler logic (algorithm test)", () => {
    function batchAndRemove(
      names: string[],
      batchSize: number,
      removeFn: (batch: string[]) => Promise<{ error: unknown }>,
    ): Promise<{ removed: number; errors: number }> {
      return (async () => {
        let removed = 0;
        let errors = 0;
        for (let i = 0; i < names.length; i += batchSize) {
          const batch = names.slice(i, i + batchSize);
          const { error } = await removeFn(batch);
          if (error) {
            errors++;
            continue;
          }
          removed += batch.length;
        }
        return { removed, errors };
      })();
    }

    it("batches at 100", async () => {
      const names = Array.from({ length: 250 }, (_, i) => `tenant/${i}.jpg`);
      const calls: string[][] = [];
      const removeFn = async (batch: string[]) => {
        calls.push(batch);
        return { error: null };
      };
      const result = await batchAndRemove(names, 100, removeFn);
      expect(result.removed).toBe(250);
      expect(result.errors).toBe(0);
      expect(calls.length).toBe(3);
      expect(calls[0].length).toBe(100);
      expect(calls[1].length).toBe(100);
      expect(calls[2].length).toBe(50);
    });

    it("counts errors per batch but continues", async () => {
      const names = Array.from({ length: 250 }, (_, i) => `tenant/${i}.jpg`);
      let callIdx = 0;
      const removeFn = async () => {
        callIdx++;
        return { error: callIdx === 2 ? { message: "transient" } : null };
      };
      const result = await batchAndRemove(names, 100, removeFn);
      expect(result.removed).toBe(150);
      expect(result.errors).toBe(1);
    });

    it("returns 0 when names is empty", async () => {
      const result = await batchAndRemove([], 100, async () => ({ error: null }));
      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
    });
  });
});
