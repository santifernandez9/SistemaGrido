import 'dotenv/config';
import { buildServer } from './server.js';

async function main() {
  const app = await buildServer();

  try {
    await app.listen({ host: '0.0.0.0', port: app.config.port });
  } catch (err) {
    app.log.fatal({ err }, 'No se pudo iniciar el servidor');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} recibido, cerrando servidor...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
