-- Etapa 6.1 -- Hardening transaccional del cierre semanal.
--
-- Corrige una carrera real en `closeWeeklyClosing`: la versión de Etapa 6
-- calculaba el ajuste COUNT_CORRECTION como
--   (cantidad real del conteo) - (saldo VIGENTE del ledger al momento de cerrar)
-- lo que podía absorber, como si fueran parte de la diferencia física del
-- conteo, movimientos legítimos (ventas, mermas, etc.) ocurridos DESPUÉS
-- del conteo pero antes/durante el cierre. La corrección ahora aplica
-- SIEMPRE la diferencia histórica congelada del conteo
-- (`InventoryCountItem.difference`, copiada a `InventorySnapshotItem`), y
-- determina si esa diferencia ya fue reconciliada consultando la
-- trazabilidad YA PERSISTIDA del propio ledger (`InventoryMovement
-- .sourceDocumentType = 'WEEKLY_CLOSING'` + `.sourceDocumentId =
-- WeeklyClosing.id`, mecanismo reservado desde Etapa 3) en vez de comparar
-- contra el saldo actual -- ver `apps/api/src/services/weekly-closing.ts`,
-- `closeWeeklyClosing`, y docs/ETAPA-6-CIERRE-SEMANAL.md, sección "Etapa
-- 6.1 -- Consistencia temporal de la reconciliación".
--
-- Como consecuencia, un mismo COUNT_CORRECTION puede quedar referenciado
-- por más de una `InventorySnapshotItem` (una por cada revisión del cierre
-- que reutiliza el ajuste ya aplicado en vez de duplicarlo) -- el UNIQUE
-- anterior sobre `inventory_snapshot_item.count_correction_movement_id`
-- (que exigía "a lo sumo una fila de snapshot por movimiento") ya no es un
-- invariante válido y se reemplaza por un índice simple (para las
-- búsquedas por movimiento, sin la restricción de unicidad).
--
-- La garantía real -- "un mismo cierre genera a lo sumo UN
-- COUNT_CORRECTION por producto en toda su vida" -- se agrega ahora del
-- lado correcto, `inventory_movement`, como índice único PARCIAL (Prisma
-- no expresa un WHERE condicional declarativamente -- agregado a mano,
-- mismo patrón que `inventory_movement_unique_reversal_per_original` de
-- Etapa 3.1). Es la protección de última instancia a nivel de PostgreSQL:
-- incluso si un futuro bug de aplicación intentara generar una segunda
-- corrección para el mismo (cierre, producto), la base de datos la
-- rechazaría.

-- DropIndex
DROP INDEX "inventory_snapshot_item_organization_id_count_correction_mo_key";

-- CreateIndex
CREATE INDEX "inventory_snapshot_item_organization_id_count_correction_mo_idx" ON "inventory_snapshot_item"("organization_id", "count_correction_movement_id");

-- CreateIndex (único parcial, sólo para movimientos COUNT_CORRECTION
-- originados por un cierre semanal -- no afecta ADJUSTMENT ni ningún otro
-- movimiento que también use `source_document_type`/`source_document_id`
-- con otro significado).
CREATE UNIQUE INDEX "inventory_movement_unique_count_correction_per_closing_product" ON "inventory_movement"("organization_id", "source_document_id", "product_id") WHERE "movement_type" = 'COUNT_CORRECTION' AND "source_document_type" = 'WEEKLY_CLOSING';
