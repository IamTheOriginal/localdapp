// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeAppCamera } from '../services/codeAppCamera.ts';

describe('Code App host camera lifecycle', () => {
  let allowed: boolean;
  let camera: CodeAppCamera;
  let getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>>;
  let stop: ReturnType<typeof vi.fn>;
  let stream: MediaStream;

  beforeEach(() => {
    allowed = true;
    stop = vi.fn();
    const track = Object.assign(new EventTarget(), { stop });
    stream = { active: true, getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    getUserMedia = vi.fn(() => Promise.resolve(stream));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { isSecureContext: true }));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
      const element = createElement(tag, options);
      if (tag === 'video') Object.defineProperties(element, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
      return element;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['jpeg-frame'], { type: 'image/jpeg' }));
    });
    camera = new CodeAppCamera(() => allowed);
  });

  afterEach(() => {
    camera?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fails closed before opening hardware and before delivering a revoked frame', async () => {
    allowed = false;
    await expect(camera.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getUserMedia).not.toHaveBeenCalled();
    allowed = true;
    await camera.start();
    allowed = false;
    await expect(camera.frame()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('returns successive bounded live frames while requesting video only', async () => {
    await camera.start({ facingMode: 'environment' });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const first = await camera.frame();
    const second = await camera.frame();
    expect(first).toMatchObject({ mime: 'image/jpeg', width: 1280, height: 720 });
    expect(first.bytes.byteLength).toBeGreaterThan(0);
    expect(second.bytes).not.toBe(first.bytes);
    camera.stop();
    expect(stop).toHaveBeenCalledOnce();
    expect(document.querySelector('video')).toBeNull();
    await expect(camera.frame()).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('releases a late permission grant after closing the app', async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
    const opening = camera.start();
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    camera.destroy();
    await rejected;
    grant(stream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(document.querySelector('video')).toBeNull();
  });

  it('times out an unanswered browser prompt and releases a subsequent grant', async () => {
    vi.useFakeTimers();
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
    const rejected = expect(camera.start()).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    grant(stream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops when hidden, and a denied request leaves the next user retry usable', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(camera.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    await camera.start();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stop).toHaveBeenCalledOnce();
    await expect(camera.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not open a second capture while permission is pending or accept audio options', async () => {
    await expect(camera.start({ audio: true })).rejects.toThrow('Unknown camera option');
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
    const opening = camera.start();
    await expect(camera.start()).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(getUserMedia).toHaveBeenCalledOnce();
    grant(stream);
    await opening;
  });
});
