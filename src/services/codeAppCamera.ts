/**
 * Camera capture belongs to the host: getUserMedia rejects the opaque origin of
 * a sandboxed srcdoc, even with allow="camera". Only bounded JPEG frames cross
 * the authenticated bridge; the app never gains the host's origin or a stream.
 */
const MAX_FRAME_SIZE = 1280;
const MIN_FRAME_INTERVAL_MS = 1000 / 15;
const OPEN_TIMEOUT_MS = 60_000;

export interface CodeAppCameraFrame {
  bytes: ArrayBuffer;
  mime: 'image/jpeg';
  width: number;
  height: number;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Camera stopped.', 'AbortError');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) reject(abortReason(signal));
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

interface CameraSession {
  abort: AbortController;
  video: HTMLVideoElement;
  stream: MediaStream | null;
  ready: boolean;
}

/** One camera per runtime; destroy on iframe replacement/unmount. */
export class CodeAppCamera {
  private session: CameraSession | null = null;
  private disposed = false;
  private capturing = false;
  private lastFrameAt = 0;
  private readonly isAllowed: () => boolean;

  constructor(isAllowed: () => boolean) {
    this.isAllowed = isAllowed;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  private onVisibilityChange = () => { if (document.hidden) this.stop(); };
  private onPageHide = () => { this.stop(); };

  private requirePermission(): void {
    if (!this.isAllowed()) {
      this.stop();
      throw new DOMException('Camera access requires permissions.device.camera: true in manifest.yaml.', 'NotAllowedError');
    }
    if (this.disposed) throw new DOMException('Code App runtime closed.', 'AbortError');
  }

  async start(options: unknown = {}): Promise<{ width: number; height: number }> {
    this.requirePermission();
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('$camera.start expects an options object.');
    const input = options as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== 'facingMode')) throw new TypeError('Unknown camera option.');
    const facingMode = input.facingMode ?? 'environment';
    if (facingMode !== 'environment' && facingMode !== 'user') throw new TypeError('Camera facingMode must be "environment" or "user".');
    if (document.hidden) throw new DOMException('Open the app before starting the camera.', 'NotAllowedError');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('Camera access requires HTTPS or localhost and a browser with camera support.', 'NotSupportedError');
    }
    if (this.session) throw new DOMException('Camera is already open or opening; stop it before starting again.', 'InvalidStateError');

    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    // Keep a rendered host video for mobile Safari. It never covers app content.
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;left:0';
    document.body.append(video);
    const session: CameraSession = { abort: new AbortController(), video, stream: null, ready: false };
    this.session = session;
    const { signal } = session.abort;
    const timer = setTimeout(() => {
      if (this.session === session) this.stop(new DOMException('Camera did not open within 60 seconds.', 'TimeoutError'));
    }, OPEN_TIMEOUT_MS);
    try {
      const pending = navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: MAX_FRAME_SIZE }, height: { ideal: 720 } },
        audio: false,
      }).then((stream) => {
        // Browser permission prompts cannot be cancelled. A late grant must
        // release the device, not revive a closed/replaced app.
        if (signal.aborted || !this.isAllowed()) {
          stream.getTracks().forEach((track) => track.stop());
          throw new DOMException('Camera request cancelled.', 'AbortError');
        }
        session.stream = stream;
        stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
          if (this.session === session) this.stop();
        }, { once: true }));
        return stream;
      });
      video.srcObject = await abortable(pending, signal);
      await abortable(video.play(), signal);
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            video.removeEventListener('loadeddata', loaded);
            signal.removeEventListener('abort', aborted);
          };
          const loaded = () => { cleanup(); resolve(); };
          const aborted = () => { cleanup(); reject(abortReason(signal)); };
          video.addEventListener('loadeddata', loaded, { once: true });
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      this.requirePermission();
      if (signal.aborted) throw abortReason(signal);
      session.ready = true;
      this.lastFrameAt = 0;
      return { width: video.videoWidth, height: video.videoHeight };
    } catch (error) {
      if (this.session === session) this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async frame(): Promise<CodeAppCameraFrame> {
    this.requirePermission();
    const session = this.session;
    if (!session?.ready || !session.stream?.active) throw new DOMException('Camera is not running. Start it again.', 'InvalidStateError');
    if (this.capturing) throw new DOMException('A camera frame is already being captured.', 'InvalidStateError');
    this.capturing = true;
    try {
      // Pull-based backpressure: one frame at a time, at most 15 per second.
      const wait = Math.max(0, MIN_FRAME_INTERVAL_MS - (performance.now() - this.lastFrameAt));
      if (wait) await abortable(new Promise<void>((resolve) => setTimeout(resolve, wait)), session.abort.signal);
      const { video } = session;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new DOMException('Camera has no image yet.', 'NotReadableError');
      const scale = Math.min(1, MAX_FRAME_SIZE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Camera image processing is unavailable.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await abortable(new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((image) => image ? resolve(image) : reject(new Error('Camera frame encoding failed.')), 'image/jpeg', 0.9);
      }), session.abort.signal);
      const bytes = await blob.arrayBuffer();
      this.requirePermission();
      if (session.abort.signal.aborted) throw abortReason(session.abort.signal);
      this.lastFrameAt = performance.now();
      return { bytes, mime: 'image/jpeg', width: canvas.width, height: canvas.height };
    } finally {
      this.capturing = false;
    }
  }

  stop(reason: DOMException = new DOMException('Camera stopped.', 'AbortError')): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.abort.abort(reason);
    session.stream?.getTracks().forEach((track) => track.stop());
    session.video.pause();
    session.video.srcObject = null;
    session.video.remove();
  }

  destroy(): void {
    this.disposed = true;
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
  }
}
