#!/usr/bin/env node
/**
 * Always-on headless runtime ("keeper node") launcher — see docs/HEADLESS.md.
 *
 * Runs the TypeScript runtime in src/headless/ directly via Node's native
 * type stripping (stable since Node 23.6), so there is no build step: the
 * same sources the browser ships from are what the keeper executes.
 *
 * Env: HEADLESS_DATA_DIR (default ./headless-data), SIGNALING_URLS,
 *      HEADLESS_HOST, HEADLESS_PORT, HEADLESS_TOKEN, HEADLESS_DISPLAY_NAME,
 *      HEADLESS_REPLICATE_FILES, ICE_SERVERS.
 */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 23 || (major === 23 && minor < 6)) {
  console.error(`Node ${process.versions.node} is too old — the headless runtime needs Node >= 23.6 for native TypeScript type stripping.`);
  process.exit(1);
}

const { main } = await import('../src/headless/main.ts');
await main();
