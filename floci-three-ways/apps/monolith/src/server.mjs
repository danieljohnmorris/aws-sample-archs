// Container and local entrypoint. Serves the Hono app on PORT.
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { app } from './app.mjs';
import { closePool } from './db.mjs';
import { logEvent } from './log.mjs';

export async function start(port = Number(process.env.PORT || 8080)) {
  let server;
  await new Promise((resolve, reject) => {
    server = serve({ fetch: app.fetch, port }, () => resolve());
    server.once('error', reject);
  });
  const actualPort = server.address().port;
  logEvent('info', 'listening', { port: actualPort });
  return {
    server,
    port: actualPort,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await closePool();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const running = await start();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => running.close().then(() => process.exit(0), () => process.exit(1)));
  }
}
