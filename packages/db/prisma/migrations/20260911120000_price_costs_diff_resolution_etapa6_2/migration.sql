-- Etapa 6.2 -- Cierre integral del Hito 1 (ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md).
--
-- Migración puramente ADITIVA: agrega el modelo histórico de precios/costos
-- (price_list_import[_row], price_reference, price_value,
-- price_reference_product_mapping), la resolución explícita de diferencias
-- de conteo (columnas nuevas en inventory_count_item) y la detección de
-- posible error de tipeo (inventory_count_typo_candidate), la valorización
-- congelada del snapshot de cierre (columnas nuevas en
-- inventory_snapshot_item) y el cierre semanal GENERAL a nivel organización
-- (general_weekly_closing). Ninguna migración histórica se modifica; nada
-- de lo generado acá borra ni renombra una columna/tabla existente.

-- CreateEnum
CREATE TYPE "difference_resolution_kind" AS ENUM ('SHORTAGE_CONFIRMED', 'SURPLUS_RESOLVED');

-- CreateEnum
CREATE TYPE "typo_candidate_status" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "price_type" AS ENUM ('COST_WITH_TAX', 'SALE_PRICE');

-- CreateEnum
CREATE TYPE "price_list_source" AS ENUM ('HELACOR_COST_LIST', 'HELACOR_SALE_PRICE_LIST');

-- CreateEnum
CREATE TYPE "price_list_import_status" AS ENUM ('UPLOADED', 'PREVIEW_READY', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "price_list_row_status" AS ENUM ('VALID', 'ERROR');

-- CreateEnum
CREATE TYPE "general_weekly_closing_status" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "inventory_count_item" ADD COLUMN     "difference_resolution" "difference_resolution_kind",
ADD COLUMN     "difference_resolution_note" TEXT,
ADD COLUMN     "difference_resolved_at" TIMESTAMPTZ(6),
ADD COLUMN     "difference_resolved_by" UUID;

-- AlterTable
ALTER TABLE "inventory_snapshot_item" ADD COLUMN     "price_value_id" UUID,
ADD COLUMN     "total_value" DECIMAL(14,2),
ADD COLUMN     "unit_cost_with_tax" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "inventory_count_typo_candidate" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "shortage_item_id" UUID NOT NULL,
    "surplus_item_id" UUID NOT NULL,
    "compensating_quantity" DECIMAL(14,3) NOT NULL,
    "sale_price_used" DECIMAL(14,2) NOT NULL,
    "status" "typo_candidate_status" NOT NULL DEFAULT 'PENDING',
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_count_typo_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_import" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" "price_list_source" NOT NULL,
    "price_type" "price_type" NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "storage_path" TEXT,
    "raw_period_label" TEXT,
    "status" "price_list_import_status" NOT NULL DEFAULT 'UPLOADED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_from" DATE,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirm_idempotency_key" TEXT,
    "confirm_idempotency_fingerprint" TEXT,

    CONSTRAINT "price_list_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_import_row" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_list_import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_label" TEXT NOT NULL,
    "raw_category" TEXT,
    "raw_value_without_tax" DECIMAL(14,2),
    "raw_value_with_tax" DECIMAL(14,2),
    "status" "price_list_row_status" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_reference" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_type" "price_type" NOT NULL,
    "label" TEXT NOT NULL,
    "source_category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_value" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_reference_id" UUID NOT NULL,
    "price_type" "price_type" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "price_list_import_id" UUID NOT NULL,
    "price_list_import_row_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_reference_product_mapping" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_reference_id" UUID NOT NULL,
    "price_type" "price_type" NOT NULL,
    "product_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "confirmed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_reference_product_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "general_weekly_closing" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "general_weekly_closing_status" NOT NULL DEFAULT 'OPEN',
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "close_idempotency_key" TEXT,
    "close_idempotency_fingerprint" TEXT,

    CONSTRAINT "general_weekly_closing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_count_typo_candidate_organization_id_count_id_sta_idx" ON "inventory_count_typo_candidate"("organization_id", "count_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_typo_candidate_organization_id_count_id_sho_key" ON "inventory_count_typo_candidate"("organization_id", "count_id", "shortage_item_id", "surplus_item_id");

-- CreateIndex
CREATE INDEX "price_list_import_organization_id_source_created_at_idx" ON "price_list_import"("organization_id", "source", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_import_organization_id_id_key" ON "price_list_import"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_import_organization_id_source_file_hash_key" ON "price_list_import"("organization_id", "source", "file_hash");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_import_organization_id_confirm_idempotency_key_key" ON "price_list_import"("organization_id", "confirm_idempotency_key");

-- CreateIndex
CREATE INDEX "price_list_import_row_organization_id_price_list_import_id__idx" ON "price_list_import_row"("organization_id", "price_list_import_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_import_row_organization_id_price_list_import_id__key" ON "price_list_import_row"("organization_id", "price_list_import_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_import_row_organization_id_id_key" ON "price_list_import_row"("organization_id", "id");

-- CreateIndex
CREATE INDEX "price_reference_organization_id_price_type_idx" ON "price_reference"("organization_id", "price_type");

-- CreateIndex
CREATE UNIQUE INDEX "price_reference_organization_id_price_type_label_key" ON "price_reference"("organization_id", "price_type", "label");

-- CreateIndex
CREATE UNIQUE INDEX "price_reference_organization_id_id_key" ON "price_reference"("organization_id", "id");

-- CreateIndex
CREATE INDEX "price_value_organization_id_price_reference_id_effective_fr_idx" ON "price_value"("organization_id", "price_reference_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "price_value_organization_id_price_reference_id_effective_fr_key" ON "price_value"("organization_id", "price_reference_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "price_value_organization_id_id_key" ON "price_value"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "price_value_organization_id_price_list_import_row_id_key" ON "price_value"("organization_id", "price_list_import_row_id");

-- CreateIndex
CREATE INDEX "price_reference_product_mapping_organization_id_product_id__idx" ON "price_reference_product_mapping"("organization_id", "product_id", "price_type");

-- CreateIndex
CREATE INDEX "price_reference_product_mapping_organization_id_price_refer_idx" ON "price_reference_product_mapping"("organization_id", "price_reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_reference_product_mapping_organization_id_price_refer_key" ON "price_reference_product_mapping"("organization_id", "price_reference_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "general_weekly_closing_organization_id_period_start_key" ON "general_weekly_closing"("organization_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "general_weekly_closing_organization_id_close_idempotency_ke_key" ON "general_weekly_closing"("organization_id", "close_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_item_organization_id_id_key" ON "inventory_count_item"("organization_id", "id");

-- CreateIndex
CREATE INDEX "inventory_snapshot_item_organization_id_price_value_id_idx" ON "inventory_snapshot_item"("organization_id", "price_value_id");

-- AddForeignKey
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_organization_id_difference_resolved_b_fkey" FOREIGN KEY ("organization_id", "difference_resolved_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_organization_id_count_id_fkey" FOREIGN KEY ("organization_id", "count_id") REFERENCES "inventory_count"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_organization_id_shortage_it_fkey" FOREIGN KEY ("organization_id", "shortage_item_id") REFERENCES "inventory_count_item"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_organization_id_surplus_ite_fkey" FOREIGN KEY ("organization_id", "surplus_item_id") REFERENCES "inventory_count_item"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_organization_id_resolved_by_fkey" FOREIGN KEY ("organization_id", "resolved_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_import" ADD CONSTRAINT "price_list_import_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_import" ADD CONSTRAINT "price_list_import_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_import" ADD CONSTRAINT "price_list_import_organization_id_confirmed_by_fkey" FOREIGN KEY ("organization_id", "confirmed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_import_row" ADD CONSTRAINT "price_list_import_row_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_import_row" ADD CONSTRAINT "price_list_import_row_organization_id_price_list_import_id_fkey" FOREIGN KEY ("organization_id", "price_list_import_id") REFERENCES "price_list_import"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_reference" ADD CONSTRAINT "price_reference_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_value" ADD CONSTRAINT "price_value_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_value" ADD CONSTRAINT "price_value_organization_id_price_reference_id_fkey" FOREIGN KEY ("organization_id", "price_reference_id") REFERENCES "price_reference"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_value" ADD CONSTRAINT "price_value_organization_id_price_list_import_id_fkey" FOREIGN KEY ("organization_id", "price_list_import_id") REFERENCES "price_list_import"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_value" ADD CONSTRAINT "price_value_organization_id_price_list_import_row_id_fkey" FOREIGN KEY ("organization_id", "price_list_import_row_id") REFERENCES "price_list_import_row"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_value" ADD CONSTRAINT "price_value_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_reference_product_mapping" ADD CONSTRAINT "price_reference_product_mapping_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_reference_product_mapping" ADD CONSTRAINT "price_reference_product_mapping_organization_id_price_refe_fkey" FOREIGN KEY ("organization_id", "price_reference_id") REFERENCES "price_reference"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_reference_product_mapping" ADD CONSTRAINT "price_reference_product_mapping_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_reference_product_mapping" ADD CONSTRAINT "price_reference_product_mapping_organization_id_confirmed__fkey" FOREIGN KEY ("organization_id", "confirmed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "general_weekly_closing" ADD CONSTRAINT "general_weekly_closing_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "general_weekly_closing" ADD CONSTRAINT "general_weekly_closing_organization_id_closed_by_fkey" FOREIGN KEY ("organization_id", "closed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshot_item" ADD CONSTRAINT "inventory_snapshot_item_organization_id_price_value_id_fkey" FOREIGN KEY ("organization_id", "price_value_id") REFERENCES "price_value"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints a mano (Prisma no las declara de forma declarativa --
-- mismo patrón que las migraciones de Etapa 2/3/4/6).

-- Un producto nunca puede tener dos mapeos ACTIVOS simultáneos para el mismo
-- tipo de precio (sección 8 del prompt: "un mapeo ambiguo nunca debe
-- modificar costos/precios en silencio") -- índice único PARCIAL, Prisma no
-- lo expresa declarativamente.
CREATE UNIQUE INDEX "price_reference_product_mapping_unique_active_per_product_type"
  ON "price_reference_product_mapping"("organization_id", "product_id", "price_type")
  WHERE "active";

-- period_end siempre periodStart + 6 días -- mismo CHECK que ya usa
-- `weekly_closing` (migración 20260909140000_weekly_closing_etapa6).
ALTER TABLE "general_weekly_closing" ADD CONSTRAINT "general_weekly_closing_period_end_check" CHECK ("period_end" = "period_start" + 6);

-- Toda referencia de precio no puede tener un valor negativo (son montos en
-- pesos, nunca una cantidad con signo).
ALTER TABLE "price_value" ADD CONSTRAINT "price_value_value_non_negative_check" CHECK ("value" >= 0);
ALTER TABLE "price_list_import_row" ADD CONSTRAINT "price_list_import_row_values_non_negative_check" CHECK (
  ("raw_value_with_tax" IS NULL OR "raw_value_with_tax" >= 0) AND
  ("raw_value_without_tax" IS NULL OR "raw_value_without_tax" >= 0)
);

-- Confirmar un import de precios exige que efectivamente se haya indicado
-- una vigencia (sección 9 del prompt: nunca se infiere del archivo).
ALTER TABLE "price_list_import" ADD CONSTRAINT "price_list_import_confirmed_requires_effective_from_check" CHECK (
  "status" <> 'CONFIRMED' OR ("confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL AND "effective_from" IS NOT NULL)
);

-- Resolver una diferencia (faltante confirmado / sobrante resuelto) exige
-- quién y cuándo -- mismo criterio que `weekly_closing_reopen_reason_check`.
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_difference_resolution_check" CHECK (
  "difference_resolution" IS NULL OR ("difference_resolved_by" IS NOT NULL AND "difference_resolved_at" IS NOT NULL)
);

-- Un candidato de tipeo nunca puede compararse consigo mismo, y resolverlo
-- (CONFIRMED/REJECTED) exige quién y cuándo.
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_distinct_items_check" CHECK ("shortage_item_id" <> "surplus_item_id");
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_resolution_check" CHECK (
  "status" = 'PENDING' OR ("resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL)
);

-- Cantidad de compensación del candidato de tipeo siempre positiva (es una
-- magnitud, nunca cero -- si fuera cero no habría compensación que sugerir).
ALTER TABLE "inventory_count_typo_candidate" ADD CONSTRAINT "inventory_count_typo_candidate_compensating_quantity_positive_check" CHECK ("compensating_quantity" > 0);
