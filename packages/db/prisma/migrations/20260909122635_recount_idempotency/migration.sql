-- Etapa 4.1 (hardening final de Etapa 4), sección 2/3/7 del prompt de
-- corrección: idempotencia propia del RECONTEO (POST
-- /api/shop/counts/:id/recount), separada de la idempotencia del envío
-- ORIGINAL del conteo (inventory_count.idempotency_key/idempotency_fingerprint,
-- ya existentes desde la migración 20260909113243_shop_ops_etapa4) -- nunca
-- se reutiliza ambiguamente una clave para dos operaciones distintas.
--
-- Ambas columnas son NULLables: la mayoría de los conteos nunca pasa por un
-- reconteo (RECOUNT_REQUIRED sólo se da si hay una diferencia mayor al
-- umbral configurado). El índice único permite múltiples NULL sin
-- colisionar entre sí (comportamiento estándar de Postgres) -- sólo
-- restringe reutilizar la MISMA clave de reconteo en dos conteos distintos.

-- AlterTable
ALTER TABLE "inventory_count" ADD COLUMN     "recount_idempotency_fingerprint" TEXT,
ADD COLUMN     "recount_idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_organization_id_recount_idempotency_key_key" ON "inventory_count"("organization_id", "recount_idempotency_key");
