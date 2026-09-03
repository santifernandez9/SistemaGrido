import type { LoggerOptions } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Logging estructurado (sección 16 del prompt de Etapa 1). Fastify usa esto como su
 * logger interno (nivel, timestamp, request id de correlación ya vienen de fábrica
 * con @fastify/request-context vía `request.log`/`request.id`).
 *
 * `redact` asegura que nunca se logueen contraseñas, tokens ni secretos, incluso si
 * alguien loguea el objeto de headers/body completo por error.
 */
export function buildLoggerOptions(
  config: Pick<AppConfig, 'logLevel' | 'isProduction'>,
): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.token',
        '*.password',
        '*.token',
        '*.serviceRoleKey',
        '*.anonKey',
      ],
      censor: '[REDACTED]',
    },
    transport: config.isProduction
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
  };
}
