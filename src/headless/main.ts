import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Headless runtime entry point (started via `server/headless.mjs`).
 *
 * Boot order matters: the Node environment shims (localStorage, indexedDB,
 * WebRTC) and the blob-store backend must be in place before any store module
 * executes against them, so everything store-flavored is imported dynamically
 * after `initHeadlessEnvironment`.
 */
export async function main(): Promise<void> {
  // Backstop for an always-on process: a stray rejection (a full disk while
  // writing the n8n cursor, a WebRTC library hiccup) or an exception in a timer
  // must be logged, not turn into a container restart loop that drops the
  // in-memory event queue and leaves commands stuck in "working".
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection (keeper keeps running)', reason));
  process.on('uncaughtException', (error) => console.error('uncaught exception (keeper keeps running)', error));

  const dataDir = path.resolve(process.env.HEADLESS_DATA_DIR ?? './headless-data');

  const { loadHeadlessConfig } = await import('./config.ts');
  const configPath = path.join(dataDir, 'config.json');
  const firstBoot = !existsSync(configPath);
  const config = await loadHeadlessConfig(dataDir);

  const { initHeadlessEnvironment } = await import('./env.ts');
  await initHeadlessEnvironment({
    signalingUrls: config.signalingUrls,
    ...(config.iceServers ? { iceServers: config.iceServers } : {}),
  });

  // Dynamic ephemeral TURN credentials (e.g. Cloudflare Worker /ice).
  let disposeDynamicIce: () => void = () => undefined;
  if (config.iceServersUrl && !config.iceServers) {
    const { fetchDynamicIceServers, startDynamicIceServers } = await import('../services/signalingConfig.ts');
    await fetchDynamicIceServers(config.iceServersUrl, {
      ...(config.iceAccessToken ? { token: config.iceAccessToken } : {}),
      timeoutMs: 5000,
    });
    disposeDynamicIce = startDynamicIceServers({
      url: config.iceServersUrl,
      ...(config.iceAccessToken ? { token: config.iceAccessToken } : {}),
    });
  }

  const { configureSharedBlobStoreBackend } = await import('../services/blobStore.ts');
  const { NodeFsChunkBackend } = await import('./blobBackend.ts');
  configureSharedBlobStoreBackend(new NodeFsChunkBackend(path.join(dataDir, 'blobs')));

  const { loadOrCreateHeadlessIdentity } = await import('./identityFile.ts');
  const identity = await loadOrCreateHeadlessIdentity(dataDir, config.displayName);

  const { HeadlessRuntime } = await import('./runtime.ts');
  const runtime = new HeadlessRuntime({
    dataDir,
    identity,
    signalingUrls: config.signalingUrls,
    replicateFiles: config.replicateFiles,
    ...(config.llm ? { llm: config.llm } : {}),
    ...(config.n8n ? { n8n: config.n8n } : {}),
    ...(config.appUrl ? { appUrl: config.appUrl } : {}),
    ...(config.controlDappId ? { controlDappId: config.controlDappId } : {}),
  });
  await runtime.start();

  const { createControlServer } = await import('./control.ts');
  const server = createControlServer(runtime, { token: config.controlToken });
  server.listen(config.controlPort, config.controlHost, () => {
    console.log(`Headless keeper up — device key ${identity.publicKey.slice(0, 16)}…`);
    console.log(`Data directory:   ${dataDir}`);
    console.log(`Signaling:        ${config.signalingUrls.join(', ')}`);
    console.log(`Control surface:  http://${config.controlHost}:${config.controlPort}/`);
    // Printed once, when it is generated: a token in every boot's output ends up in
    // `docker logs` and log collectors. Afterwards it is read from the config file.
    console.log(`Control token:    ${firstBoot ? config.controlToken : `see "controlToken" in ${configPath}`}`);
    console.log(`LLM endpoint:     ${config.llm ? `${config.llm.baseUrl} (${config.llm.model ?? 'no model selected yet'})` : 'not configured (LLM_BASE_URL)'}`);
    console.log(`n8n events:       ${config.n8n ? config.n8n.url : 'not configured (N8N_WEBHOOK_URL)'}`);
    console.log(`Control dapp:     ${config.controlDappId ?? 'not created yet (open the dashboard)'}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} — flushing state…`);
    disposeDynamicIce();
    server.close();
    runtime.stop()
      .catch((error: unknown) => console.error('shutdown flush failed', error))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
