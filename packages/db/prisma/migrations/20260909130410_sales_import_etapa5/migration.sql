-- Etapa 5 -- Importador de ventas (ver docs/ETAPA-5-IMPORTADOR-VENTAS.md).
--
-- Agrega el modelo de datos del importador de ventas del POS ("Mix de
-- Ventas"), sin tocar ninguna tabla ni migración existente:
--   - sales_import / sales_import_row: archivo subido y sus filas parseadas.
--   - product_alias: mapeo ADMIN-confirmado código externo -> Product.
--   - bill_of_material_item: recetas/BOM (producto vendido -> insumos).
--   - sale: venta CONFIRMADA (hecho inmutable), referenciada 1:1 desde el
--     movimiento SALE del ledger existente (Etapa 3) vía `movement_id`.
--
-- Todas las FKs a tablas tenant-scoped son compuestas (organization_id, id)
-- para impedir cruces entre organizaciones, mismo criterio que las
-- migraciones anteriores (ver 20260903131703_multi_tenant_composite_fk).
--
-- Los movimientos BOM_CONSUMPTION que una venta genera NO agregan una tabla
-- de trazabilidad nueva: reutilizan `inventory_movement.source_document_type`
-- / `source_document_id`, reservados desde Etapa 3 para este uso exacto.

-- CreateEnum
CREATE TYPE "SalesImportSource" AS ENUM ('MIX_VENTAS');

-- CreateEnum
CREATE TYPE "SalesImportStatus" AS ENUM ('UPLOADED', 'PREVIEW_READY', 'BLOCKED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "SalesImportRowStatus" AS ENUM ('VALID', 'ERROR');

-- CreateTable
CREATE TABLE "sales_import" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "source" "SalesImportSource" NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "storage_path" TEXT,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "SalesImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "total_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "file_stated_total" DECIMAL(14,2),
    "blocked_reason" TEXT,
    "failed_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirm_idempotency_key" TEXT,
    "confirm_idempotency_fingerprint" TEXT,

    CONSTRAINT "sales_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_import_row" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sales_import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_article_code" TEXT NOT NULL,
    "raw_description" TEXT NOT NULL,
    "raw_group" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "is_promotion" BOOLEAN NOT NULL DEFAULT false,
    "is_canje" BOOLEAN NOT NULL DEFAULT false,
    "promotion_code" TEXT,
    "unit_price_avg" DECIMAL(14,4),
    "bultos" TEXT,
    "kilos" DECIMAL(14,3),
    "pct_of_total" DECIMAL(9,4),
    "status" "SalesImportRowStatus" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_alias" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" "SalesImportSource" NOT NULL,
    "external_code" TEXT NOT NULL,
    "external_description" TEXT,
    "product_id" UUID NOT NULL,
    "confirmed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_of_material_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "component_product_id" UUID NOT NULL,
    "quantity_per_unit" DECIMAL(14,6) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bill_of_material_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sales_import_id" UUID NOT NULL,
    "sales_import_row_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "amount_real" DECIMAL(14,2) NOT NULL,
    "is_promotion" BOOLEAN NOT NULL DEFAULT false,
    "is_canje" BOOLEAN NOT NULL DEFAULT false,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "movement_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_import_organization_id_location_id_created_at_idx" ON "sales_import"("organization_id", "location_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_import_organization_id_id_key" ON "sales_import"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_import_organization_id_location_id_file_hash_key" ON "sales_import"("organization_id", "location_id", "file_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sales_import_organization_id_confirm_idempotency_key_key" ON "sales_import"("organization_id", "confirm_idempotency_key");

-- CreateIndex
CREATE INDEX "sales_import_row_organization_id_sales_import_id_status_idx" ON "sales_import_row"("organization_id", "sales_import_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_import_row_organization_id_sales_import_id_row_number_key" ON "sales_import_row"("organization_id", "sales_import_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_import_row_organization_id_id_key" ON "sales_import_row"("organization_id", "id");

-- CreateIndex
CREATE INDEX "product_alias_organization_id_product_id_idx" ON "product_alias"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_alias_organization_id_source_external_code_key" ON "product_alias"("organization_id", "source", "external_code");

-- CreateIndex
CREATE INDEX "bill_of_material_item_organization_id_product_id_idx" ON "bill_of_material_item"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_of_material_item_organization_id_product_id_component__key" ON "bill_of_material_item"("organization_id", "product_id", "component_product_id");

-- CreateIndex
CREATE INDEX "sale_organization_id_location_id_occurred_at_idx" ON "sale"("organization_id", "location_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organization_id_sales_import_row_id_key" ON "sale"("organization_id", "sales_import_row_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organization_id_movement_id_key" ON "sale"("organization_id", "movement_id");

-- AddForeignKey
ALTER TABLE "sales_import" ADD CONSTRAINT "sales_import_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import" ADD CONSTRAINT "sales_import_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import" ADD CONSTRAINT "sales_import_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import" ADD CONSTRAINT "sales_import_organization_id_confirmed_by_fkey" FOREIGN KEY ("organization_id", "confirmed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import_row" ADD CONSTRAINT "sales_import_row_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import_row" ADD CONSTRAINT "sales_import_row_organization_id_sales_import_id_fkey" FOREIGN KEY ("organization_id", "sales_import_id") REFERENCES "sales_import"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_alias" ADD CONSTRAINT "product_alias_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_alias" ADD CONSTRAINT "product_alias_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_alias" ADD CONSTRAINT "product_alias_organization_id_confirmed_by_fkey" FOREIGN KEY ("organization_id", "confirmed_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_of_material_item" ADD CONSTRAINT "bill_of_material_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_of_material_item" ADD CONSTRAINT "bill_of_material_item_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_of_material_item" ADD CONSTRAINT "bill_of_material_item_organization_id_component_product_id_fkey" FOREIGN KEY ("organization_id", "component_product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_sales_import_id_fkey" FOREIGN KEY ("organization_id", "sales_import_id") REFERENCES "sales_import"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_sales_import_row_id_fkey" FOREIGN KEY ("organization_id", "sales_import_row_id") REFERENCES "sales_import_row"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
