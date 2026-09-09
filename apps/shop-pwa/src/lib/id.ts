/** Clave de idempotencia nueva para un envío (sección 12 del prompt de Etapa
 * 4: origen siempre PWA con conectividad intermitente -- reintentos con la
 * MISMA clave son la forma de recuperarse de un corte sin duplicar nada). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
