// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HubVideoPreview } from './HubVideoPreview';
import { gemini4Videos } from './gemini4Videos';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads without a referrer, reveals only a presented frame, and releases offscreen media', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['video'], { type: 'video/mp4' }) });
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
    expect(this.muted).toBe(true);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HubVideoPreview video={gemini4Videos[0]} />));
    const player = container.querySelector('video')!;
    expect(fetcher).toHaveBeenCalledWith(gemini4Videos[0].video, expect.objectContaining({ referrerPolicy: 'no-referrer' }));
    expect(player.getAttribute('src')).toBe('blob:preview');
    expect(play).toHaveBeenCalled();
    expect(player.style.opacity).toBe('0');
    let frameReady: (() => void) | undefined;
    player.requestVideoFrameCallback = vi.fn(callback => { frameReady = () => callback(0, {} as VideoFrameCallbackMetadata); return 1; });
    await act(async () => player.dispatchEvent(new Event('playing')));
    expect(player.style.opacity).toBe('0');
    await act(async () => frameReady!());
    expect(player.style.opacity).toBe('1');
    await act(async () => player.dispatchEvent(new Event('error')));
    expect(player.style.opacity).toBe('0');
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(revoke).toHaveBeenCalledWith('blob:preview');
});

it('keeps the poster on failed requests without attempting playback', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HubVideoPreview video={gemini4Videos[0]} />));
    expect(container.querySelector('video')!.style.opacity).toBe('0');
    expect(play).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
