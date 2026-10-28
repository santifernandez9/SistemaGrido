-- Etapa 6.2.1 (correcciones finales del Hito 1) -- migración puramente
-- ADITIVA: una única columna nueva, nullable, sin tocar ninguna migración
-- histórica ni ningún dato existente.
--
-- `inventory_count_item.deposito_closed_units` (secciones 2/3/4 del prompt,
-- CONFIRMADO por las planillas físicas reales del cliente): sólo se usa en
-- productos SABOR (`product.flavor_id` no nulo), donde la planilla real
-- distingue una columna "Salón" (closed_units/open_units/open_fraction, ya
-- existentes desde Etapa 4) de una columna "Depósito" -- existencia de latas
-- CERRADAS guardadas en el depósito/cámara PROPIO de esa misma heladería.
-- Ver el comentario extenso de `InventoryCountItem` en schema.prisma.

-- AlterTable
ALTER TABLE "inventory_count_item" ADD COLUMN     "deposito_closed_units" INTEGER;

-- CHECK agregado a mano (Prisma no expresa CHECK declarativamente) -- mismo
-- patrón que `closed_units`/`open_units` de la migración de Etapa 4.
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_deposito_closed_units_check" CHECK ("deposito_closed_units" IS NULL OR "deposito_closed_units" >= 0);
