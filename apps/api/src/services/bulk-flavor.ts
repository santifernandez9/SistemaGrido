import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type { OpenContainerFraction } from '@sistema-grido/shared-types';

/**
 * Multiplicador de cada fracción estimada (RF-020/RN-025) sobre la
 * capacidad de una lata abierta. Las cuatro primeras son literales (3/4 es
 * 0.75, no una decisión de negocio); `NEARLY_EMPTY` ("casi vacía") NO tiene
 * un valor literal en su nombre -- ese valor es la única parte configurable
 * de esta tabla (`BULK_FLAVOR_NEARLY_EMPTY_FRACTION`, con default 0.10,
 * documentado como supuesto pendiente en docs/ETAPA-4-APP-HELADERIA.md,
 * "Supuestos"). Fuente única para el conteo de sabores (InventoryCountItem)
 * y para una merma registrada como fracción de una lata (Waste) -- ver
 * `apps/api/src/services/inventory-ledger.ts` y
 * `apps/api/src/services/inventory-count.ts`.
 */
export function openContainerFractionMultiplier(
  fastify: FastifyInstance,
  fraction: OpenContainerFraction,
): Prisma.Decimal {
  switch (fraction) {
    case 'FULL':
      return new Prisma.Decimal('1');
    case 'THREE_QUARTERS':
      return new Prisma.Decimal('0.75');
    case 'HALF':
      return new Prisma.Decimal('0.5');
    case 'QUARTER':
      return new Prisma.Decimal('0.25');
    case 'NEARLY_EMPTY':
      return new Prisma.Decimal(fastify.config.shopOps.bulkFlavorNearlyEmptyFraction);
  }
}
