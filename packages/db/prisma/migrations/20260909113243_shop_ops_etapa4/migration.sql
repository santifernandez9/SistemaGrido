-- Etapa 4 — App Heladería Operativa. Ver docs/ETAPA-4-APP-HELADERIA.md.
--
-- 5 tablas nuevas: inventory_count, inventory_count_item, waste,
-- variable_expense, stockout_event. NO modifica inventory_movement ni
-- ninguna migración previa. "Dar de baja lata" (sección 7 del prompt de
-- Etapa 4) no tiene tabla propia -- reutiliza inventory_movement
-- (movement_type = ICE_CREAM_CONTAINER_CLOSE) tal cual ya existe desde
-- Etapa 3, sin ningún cambio de esquema.

-- CreateEnum
CREATE TYPE "inventory_count_status" AS ENUM ('DRAFT', 'SUBMITTED', 'RECOUNT_REQUIRED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "open_container_fraction" AS ENUM ('FULL', 'THREE_QUARTERS', 'HALF', 'QUARTER', 'NEARLY_EMPTY');

-- CreateEnum
CREATE TYPE "stockout_classification" AS ENUM ('URGENT_RESTOCK', 'SUPPLY_SHORTAGE');

-- CreateTable
CREATE TABLE "inventory_count" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "status" "inventory_count_status" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recounted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "idempotency_fingerprint" TEXT NOT NULL,

    CONSTRAINT "inventory_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "closed_units" INTEGER,
    "open_units" INTEGER,
    "open_fraction" "open_container_fraction",
    "physical_quantity" DECIMAL(14,3) NOT NULL,
    "theoretical_quantity" DECIMAL(14,3),
    "difference" DECIMAL(14,3),
    "needs_recount" BOOLEAN NOT NULL DEFAULT false,
    "recounted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_count_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- waste NO tiene columnas de idempotencia propias: reutiliza las de la fila
-- de inventory_movement a la que está atada 1:1 (movement_id) -- ver la nota
-- en el modelo Waste de schema.prisma.
CREATE TABLE "waste" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "photo_path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variable_expense" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "receipt_path" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "idempotency_fingerprint" TEXT NOT NULL,

    CONSTRAINT "variable_expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stockout_event" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "classification" "stockout_classification",
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "idempotency_fingerprint" TEXT NOT NULL,

    CONSTRAINT "stockout_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_count_organization_id_location_id_week_start_idx" ON "inventory_count"("organization_id", "location_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_organization_id_id_key" ON "inventory_count"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_organization_id_location_id_week_start_key" ON "inventory_count"("organization_id", "location_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_organization_id_idempotency_key_key" ON "inventory_count"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_count_item_organization_id_count_id_idx" ON "inventory_count_item"("organization_id", "count_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_item_count_id_product_id_key" ON "inventory_count_item"("count_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "waste_organization_id_movement_id_key" ON "waste"("organization_id", "movement_id");

-- CreateIndex
CREATE INDEX "variable_expense_organization_id_location_id_occurred_at_idx" ON "variable_expense"("organization_id", "location_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "variable_expense_organization_id_idempotency_key_key" ON "variable_expense"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "stockout_event_organization_id_location_id_occurred_at_idx" ON "stockout_event"("organization_id", "location_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "stockout_event_organization_id_idempotency_key_key" ON "stockout_event"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "inventory_count" ADD CONSTRAINT "inventory_count_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count" ADD CONSTRAINT "inventory_count_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count" ADD CONSTRAINT "inventory_count_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_organization_id_count_id_fkey" FOREIGN KEY ("organization_id", "count_id") REFERENCES "inventory_count"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste" ADD CONSTRAINT "waste_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste" ADD CONSTRAINT "waste_organization_id_movement_id_fkey" FOREIGN KEY ("organization_id", "movement_id") REFERENCES "inventory_movement"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variable_expense" ADD CONSTRAINT "variable_expense_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variable_expense" ADD CONSTRAINT "variable_expense_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variable_expense" ADD CONSTRAINT "variable_expense_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stockout_event" ADD CONSTRAINT "stockout_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stockout_event" ADD CONSTRAINT "stockout_event_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stockout_event" ADD CONSTRAINT "stockout_event_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stockout_event" ADD CONSTRAINT "stockout_event_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (Prisma no las declara de forma declarativa -- mismo
-- patrón que las migraciones de Etapa 2/3): un conteo físico o un motivo no
-- respaldado no debe poder guardarse sólo porque la aplicación se olvidó de
-- validarlo, igual que ya rige para inventory_movement desde Etapa 3.

-- inventory_count_item: conteos siempre >= 0 (no existe "-3 cajas
-- cerradas"); la fracción estimada sólo tiene sentido si hay al menos una
-- lata/unidad abierta contada -- constraint literal de RN-025 (Doc §17.1,
-- CONFIRMADO por el cliente).
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_closed_units_check" CHECK ("closed_units" IS NULL OR "closed_units" >= 0);
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_open_units_check" CHECK ("open_units" IS NULL OR "open_units" >= 0);
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_open_fraction_check" CHECK ("open_fraction" IS NULL OR "open_units" > 0);
-- Un conteo físico nunca es negativo (a diferencia de `inventory_movement.quantity`,
-- que sí puede serlo -- acá no hay signo, es un resultado de contar objetos).
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_physical_quantity_check" CHECK ("physical_quantity" >= 0);

-- variable_expense: un gasto de monto cero o negativo no representa ningún
-- hecho real (mismo criterio que `quantity <> 0` en inventory_movement).
ALTER TABLE "variable_expense" ADD CONSTRAINT "variable_expense_amount_check" CHECK ("amount" > 0);
