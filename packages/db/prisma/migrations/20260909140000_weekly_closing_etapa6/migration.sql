-- Etapa 6 -- Cierre semanal del núcleo operativo.
--
-- Agrega `weekly_closing` (una fila por ubicación y período semanal
-- lunes..domingo) e `inventory_snapshot_item` (snapshot histórico e
-- inmutable, por producto y revisión, de lo consolidado en cada cierre).
-- `inventory_movement` sigue siendo la única fuente de verdad de stock --
-- esta migración no toca sus columnas ni recalcula nada existente, sólo
-- agrega la referencia opcional `inventory_snapshot_item.count_correction_movement_id`
-- hacia movimientos COUNT_CORRECTION ya soportados desde la migración
-- original del ledger (20260903150031_inventory_ledger).
--
-- Generada con `prisma migrate diff --from-url ... --to-schema-datamodel ...
-- --script` (entorno sin TTY, `prisma migrate dev` no es viable) y
-- completada a mano con los dos CHECK que Prisma no expresa
-- declarativamente (mismo patrón que las migraciones de Etapa 2/3/4).

-- CreateEnum
CREATE TYPE "weekly_closing_status" AS ENUM ('OPEN', 'CLOSED', 'REOPENED');

-- CreateTable
CREATE TABLE "weekly_closing" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "weekly_closing_status" NOT NULL DEFAULT 'OPEN',
    "review_confirmed_by" UUID,
    "review_confirmed_at" TIMESTAMPTZ(6),
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "reopened_by" UUID,
    "reopened_at" TIMESTAMPTZ(6),
    "reopen_reason" TEXT,
    "close_idempotency_key" TEXT,
    "close_idempotency_fingerprint" TEXT,

    CONSTRAINT "weekly_closing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_snapshot_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "weekly_closing_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "quantity_theoretical" DECIMAL(14,3) NOT NULL,
    "quantity_real" DECIMAL(14,3) NOT NULL,
    "difference" DECIMAL(14,3) NOT NULL,
    "count_correction_movement_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_snapshot_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_closing_organization_id_location_id_period_start_idx" ON "weekly_closing"("organization_id", "location_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_closing_organization_id_id_key" ON "weekly_closing"("organization_id", "id");

-- CreateIndex
-- A lo sumo un WeeklyClosing por ubicación y período (sección 4 del
-- prompt: "evitar solapamiento de períodos... dos cierres activos para la
-- misma ubicación/período").
CREATE UNIQUE INDEX "weekly_closing_organization_id_location_id_period_start_key" ON "weekly_closing"("organization_id", "location_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_closing_organization_id_close_idempotency_key_key" ON "weekly_closing"("organization_id", "close_idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_snapshot_item_organization_id_location_id_product_idx" ON "inventory_snapshot_item"("organization_id", "location_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_snapshot_item_organization_id_weekly_closing_id_idx" ON "inventory_snapshot_item"("organization_id", "weekly_closing_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_snapshot_item_organization_id_weekly_closing_id_p_key" ON "inventory_snapshot_item"("organization_id", "weekly_closing_id", "product_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_snapshot_item_organization_id_count_correction_mo_key" ON "inventory_snapshot_item"("organization_id", "count_correction_movement_id");

-- AddForeignKey
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_organization_id_review_confirmed_by_fkey" FOREIGN KEY ("organization_id", "review_confirmed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_organization_id_closed_by_fkey" FOREIGN KEY ("organization_id", "closed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_organization_id_reopened_by_fkey" FOREIGN KEY ("organization_id", "reopened_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshot_item" ADD CONSTRAINT "inventory_snapshot_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshot_item" ADD CONSTRAINT "inventory_snapshot_item_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshot_item" ADD CONSTRAINT "inventory_snapshot_item_organization_id_weekly_closing_id_fkey" FOREIGN KEY ("organization_id", "weekly_closing_id") REFERENCES "weekly_closing"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshot_item" ADD CONSTRAINT "inventory_snapshot_item_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshot_item" ADD CONSTRAINT "inventory_snapshot_item_organization_id_count_correction_m_fkey" FOREIGN KEY ("organization_id", "count_correction_movement_id") REFERENCES "inventory_movement"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheck (Prisma no expresa CHECK declarativamente -- agregado a mano,
-- mismo patrón que el CHECK de `units_per_handling_unit`/`reason` en
-- migraciones previas). Documento del cliente, sección 24: "Período: lunes
-- a domingo" -- el período siempre abarca exactamente 7 días.
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_period_end_check" CHECK ("period_end" = "period_start" + 6);

-- AddCheck -- sección 12 del prompt: la reapertura es una operación
-- sensible que exige motivo obligatorio. NULL en ambos campos (nunca
-- reabierto) sigue siendo válido; lo que se prohíbe es `reopened_at` sin
-- `reopen_reason`.
ALTER TABLE "weekly_closing" ADD CONSTRAINT "weekly_closing_reopen_reason_check" CHECK ("reopened_at" IS NULL OR "reopen_reason" IS NOT NULL);
