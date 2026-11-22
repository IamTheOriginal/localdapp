// Minimal typing for the browser bundle of simple-peer (same import y-webrtc
// uses, so no Node polyfills are pulled into the Vite build).
declare module 'simple-peer/simplepeer.min.js' {
  export interface SimplePeerOptions {
    initiator?: boolean;
    trickle?: boolean;
    config?: unknown;
  }

  export default class SimplePeer {
    constructor(options?: SimplePeerOptions);
    on(event: 'signal', callback: (data: unknown) => void): void;
    on(event: 'connect', callback: () => void): void;
    on(event: 'data', callback: (data: Uint8Array) => void): void;
    on(event: 'close', callback: () => void): void;
    on(event: 'error', callback: (error: Error) => void): void;
    signal(data: unknown): void;
    send(data: Uint8Array): void;
    destroy(): void;
    destroyed: boolean;
    _channel?: { bufferedAmount?: number };
  }
}
