import { Prisma } from '@sistema-grido/db';

/**
 * Utilidades de idempotencia compartidas por todos los servicios que
 * aceptan un `idempotencyKey` propio (inventory-ledger.ts desde Etapa 3.1/
 * 3.2, y los nuevos de Etapa 4: inventory-count.ts, variable-expense.ts,
 * stockout.ts). Extraídas acá porque el patrón -- capturar P2002,
 * distinguir por `err.meta.target` cuál UNIQUE se violó realmente, nunca
 * asumir que cualquier P2002 es una colisión de idempotencia -- es
 * genuinamente genérico, sin conocimiento de dominio. Ver
 * docs/ETAPA-3.2-IDEMPOTENCIA-CONCURRENTE.md para el razonamiento completo
 * detrás de este mecanismo.
 */

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function isUniqueConstraintViolationOn(
  err: unknown,
  targetColumns: readonly string[],
): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  if (!Array.isArray(target)) return false;
  return (
    target.length === targetColumns.length &&
    targetColumns.every((column) => target.includes(column))
  );
}
