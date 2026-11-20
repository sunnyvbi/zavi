import { describe, it, expect, vi } from "vitest";
import { readChannelStatesSeeded } from "../list";
import type { ChannelStatesRead } from "@/services/channels/state";

const empty: ChannelStatesRead = { states: [], rowCount: 0, error: null };
const seededRead: ChannelStatesRead = { states: [], rowCount: 22, error: null };

describe("readChannelStatesSeeded", () => {
  it("seeds a tenant that has no channel rows and returns the re-read", async () => {
    const read = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(seededRead);
    const seed = vi.fn().mockResolvedValue({ channels_inserted: 22, error: null });

    const out = await readChannelStatesSeeded(read, seed);

    expect(seed).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(out.rowCount).toBe(22);
  });

  it("does not seed a tenant that already has rows", async () => {
    const read = vi.fn().mockResolvedValue(seededRead);
    const seed = vi.fn();

    const out = await readChannelStatesSeeded(read, seed);

    expect(seed).not.toHaveBeenCalled();
    expect(out).toBe(seededRead);
  });

  it("does not seed when the read itself failed", async () => {
    const failed: ChannelStatesRead = { states: [], rowCount: 0, error: "boom" };
    const read = vi.fn().mockResolvedValue(failed);
    const seed = vi.fn();

    expect(await readChannelStatesSeeded(read, seed)).toBe(failed);
    expect(seed).not.toHaveBeenCalled();
  });

  it("re-reads after a successful zero insert and keeps the empty answer on seed errors", async () => {
    const read = vi.fn().mockResolvedValue(empty);

    expect(await readChannelStatesSeeded(read, vi.fn().mockResolvedValue({ channels_inserted: 0, error: null }))).toBe(empty);
    expect(await readChannelStatesSeeded(read, vi.fn().mockResolvedValue({ channels_inserted: 0, error: "rpc down" }))).toBe(empty);
    expect(await readChannelStatesSeeded(read, vi.fn().mockRejectedValue(new Error("network")))).toBe(empty);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

it("sees rows inserted by a concurrent bootstrap when its own insert conflicts", async () => {
  const read = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(seededRead);
  const seed = vi.fn().mockResolvedValue({ channels_inserted: 0, error: null });
  expect(await readChannelStatesSeeded(read, seed)).toBe(seededRead);
  expect(read).toHaveBeenCalledTimes(2);
});
it("preserves the re-read error instead of inventing disconnected channel state", async () => {
  const failure: ChannelStatesRead = { states: [], rowCount: 0, error: "refresh failed" };
  const read = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(failure);
  expect(await readChannelStatesSeeded(read, vi.fn().mockResolvedValue({ channels_inserted: 0, error: null }))).toBe(failure);
});
