// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { fitLevels, useAudioLevels } from "./useAudioLevels";

const stopTrack = vi.fn();
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
const closeContext = vi.fn(async () => {});
let frames: FrameRequestCallback[] = [];
let sample = 128;

class FakeAudioContext {
  createAnalyser() {
    return {
      fftSize: 0,
      getByteTimeDomainData(out: Uint8Array) {
        out.fill(sample);
      },
    };
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  close = closeContext;
}

beforeEach(() => {
  stopTrack.mockClear();
  getUserMedia.mockClear();
  closeContext.mockClear();
  frames = [];
  sample = 128;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flushFrame = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb(0));
  });

describe("useAudioLevels", () => {
  it("resizes the wave without reopening the microphone when the bar count changes mid-recording", async () => {
    const { result, rerender } = renderHook((bars: number) => useAudioLevels({ enabled: true, paused: false, bars }), {
      initialProps: 20,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    sample = 255;
    flushFrame();
    expect(result.current).toHaveLength(20);
    expect(result.current[19]).toBe(1);

    rerender(80);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toHaveLength(80);
    expect(result.current[79]).toBe(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stopTrack).not.toHaveBeenCalled();
    expect(closeContext).not.toHaveBeenCalled();

    flushFrame();
    expect(result.current).toHaveLength(80);
    expect(result.current.slice(-2)).toEqual([1, 1]);

    rerender(10);
    expect(result.current).toHaveLength(10);
    flushFrame();
    expect(result.current).toHaveLength(10);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("fitLevels keeps the newest samples on the right and pads the left with silence", () => {
    expect(fitLevels([0.2, 0.4, 0.6], 2)).toEqual([0.4, 0.6]);
    expect(fitLevels([0.6], 3)).toEqual([0.08, 0.08, 0.6]);
    expect(fitLevels([], 0)).toEqual([]);
  });
});
