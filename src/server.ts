import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';
const env = loadEnv();
const app = await buildApp(env);
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
