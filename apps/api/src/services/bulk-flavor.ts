import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type { OpenContainerFraction } from '@sistema-grido/shared-types';
import { ConfigurationError } from '../errors.js';

/**
 * Multiplicador de cada fracción estimada (RF-020/RN-025) sobre la
 * capacidad de una lata abierta. Las cuatro primeras son literales (3/4 es
 * 0.75, no una decisión de negocio); `NEARLY_EMPTY` ("casi vacía") NO tiene
 * un valor literal en su nombre ni un default -- el cliente nunca confirmó
 * a qué número equivale (Etapa 4.1, sección 1). Si
 * `BULK_FLAVOR_NEARLY_EMPTY_FRACTION` no está configurada, esta función
 * rechaza con `ConfigurationError` en vez de inventar un número, devolver
 * `NaN` o caer en un cero implícito -- fuente única para el conteo de
 * sabores (InventoryCountItem) y para una merma registrada como fracción de
 * una lata (Waste), ver `apps/api/src/services/inventory-ledger.ts` y
 * `apps/api/src/services/inventory-count.ts`; en ambos casos se llama ANTES
 * de escribir nada, así que el rechazo aborta la operación completa sin
 * dejar ningún estado a medio crear.
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
    case 'NEARLY_EMPTY': {
      const configured = fastify.config.shopOps.bulkFlavorNearlyEmptyFraction;
      if (configured === undefined) {
        throw new ConfigurationError(
          'La fracción "casi vacía" (NEARLY_EMPTY) todavía no tiene un valor numérico ' +
            'confirmado por el cliente. Configurá BULK_FLAVOR_NEARLY_EMPTY_FRACTION para ' +
            'habilitar esta operación -- ver docs/ETAPA-4-APP-HELADERIA.md, "Supuestos".',
        );
      }
      return new Prisma.Decimal(configured);
    }
  }
}
