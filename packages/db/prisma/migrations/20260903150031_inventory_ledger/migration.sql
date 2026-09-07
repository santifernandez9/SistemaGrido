-- Etapa 3 — Motor de inventario / ledger de stock
-- Ver docs/ETAPA-3-MOTOR-INVENTARIO.md y docs/INVARIANTES-INVENTARIO.md.
--
-- Crea el ledger append-only (inventory_movement) que es, a partir de acá,
-- la única fuente de verdad del stock (RN-007: "el stock de cada producto en
-- cada ubicación es siempre la suma de sus movimientos en el ledger"). No se
-- crea ninguna columna/tabla de "stock actual": el saldo se calcula siempre
-- agregando esta tabla en el momento de la consulta.
--
-- Además corrige, junto con esta migración, el pendiente detectado en Etapa
-- 2.1 (docs/ETAPA-2.1-INTEGRIDAD-MULTIORGANIZACION.md, sección 14):
-- app_user.default_location_id -> location y audit_log.user_id/location_id
-- pasan de FK simple a FK compuesta (organization_id, x), mismo patrón que
-- Etapa 2.1 ya aplicó al catálogo.

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'BOM_CONSUMPTION', 'WASTE', 'ICE_CREAM_CONTAINER_CLOSE', 'ADJUSTMENT', 'EXTERNAL_OUT', 'COUNT_CORRECTION');

-- CreateEnum
CREATE TYPE "movement_status" AS ENUM ('ACTIVE', 'REVERSED');

-- DropForeignKey (pendiente de Etapa 2.1: se reemplazan por FK compuesta más abajo)
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_default_location_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_location_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_user_id_fkey";

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "movement_type" "movement_type" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "entered_quantity" DECIMAL(14,3) NOT NULL,
    "entry_unit_of_measure_id" UUID NOT NULL,
    "conversion_factor" INTEGER NOT NULL,
    "reason" TEXT,
    "source_document_type" TEXT,
    "source_document_id" UUID,
    "idempotency_key" TEXT,
    "reverses_movement_id" UUID,
    "status" "movement_status" NOT NULL DEFAULT 'ACTIVE',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id"),
    -- RN-010/arquitectura Etapa 0 §10.3: un movimiento con cantidad 0 no
    -- representa ningún hecho real; se rechaza a nivel de base de datos,
    -- igual criterio que el CHECK de `units_per_handling_unit` de Etapa 2.
    CONSTRAINT "inventory_movement_quantity_not_zero" CHECK ("quantity" <> 0),
    CONSTRAINT "inventory_movement_entered_quantity_not_zero" CHECK ("entered_quantity" <> 0),
    CONSTRAINT "inventory_movement_conversion_factor_positive" CHECK ("conversion_factor" > 0),
    -- Arquitectura Etapa 0 §10.3 / prompt Etapa 3 sección 12: ADJUSTMENT (y
    -- COUNT_CORRECTION cuando exista) requieren motivo obligatorio; Prisma no
    -- expresa un NOT NULL condicional de forma declarativa, así que se agrega
    -- a mano, igual patrón que el CHECK de Etapa 2.
    CONSTRAINT "inventory_movement_reason_required_for_adjustment" CHECK (
        "reason" IS NOT NULL OR "movement_type" NOT IN ('ADJUSTMENT', 'COUNT_CORRECTION')
    ),
    -- Un movimiento no puede revertirse a sí mismo.
    CONSTRAINT "inventory_movement_reverses_not_self" CHECK ("reverses_movement_id" IS NULL OR "reverses_movement_id" <> "id")
);

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_location_id_product_id_o_idx" ON "inventory_movement"("organization_id", "location_id", "product_id", "occurred_at");

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_source_document_type_sou_idx" ON "inventory_movement"("organization_id", "source_document_type", "source_document_id");

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_movement_type_idx" ON "inventory_movement"("organization_id", "movement_type");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_organization_id_id_key" ON "inventory_movement"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_organization_id_idempotency_key_key" ON "inventory_movement"("organization_id", "idempotency_key");

-- Protección contra carga de stock inicial duplicada (prompt Etapa 3, sección
-- 8: "definir protección contra cargas iniciales accidentales repetidas").
-- Índice único PARCIAL (no expresable declarativamente en schema.prisma, se
-- agrega a mano): a lo sumo un movimiento INITIAL_STOCK "original" (no una
-- reversión) activo por organización/ubicación/producto.
--
-- `reverses_movement_id IS NULL` es necesario porque una reversión reutiliza
-- el mismo movement_type que el movimiento que revierte (sección "Reversión"
-- de docs/ETAPA-3-MOTOR-INVENTARIO.md): si se revierte un INITIAL_STOCK, la
-- reversión queda como una fila INITIAL_STOCK/ACTIVE más, pero es una
-- corrección, no una segunda carga de stock inicial -- si el índice la
-- contara, revertir un stock inicial equivocado dejaría imposible cargar uno
-- nuevo (la propia reversión ocuparía el lugar para siempre).
--
-- Si se revierte el INITIAL_STOCK original (mecanismo genérico de reversión,
-- sección 13), su status pasa a REVERSED y el índice deja de contarlo,
-- permitiendo cargar un nuevo stock inicial -- comportamiento correcto, no un
-- agujero: revertir el inicial es una acción explícita y auditada de Admin,
-- no una carga accidental.
CREATE UNIQUE INDEX "inventory_movement_unique_active_initial_stock" ON "inventory_movement"("organization_id", "location_id", "product_id") WHERE "movement_type" = 'INITIAL_STOCK' AND "status" = 'ACTIVE' AND "reverses_movement_id" IS NULL;

-- CreateIndex (Etapa 2.1: habilitan las FKs compuestas de más abajo)
CREATE UNIQUE INDEX "app_user_organization_id_id_key" ON "app_user"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "location_organization_id_id_key" ON "location"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_organization_id_id_key" ON "product"("organization_id", "id");

-- AddForeignKey (pendiente de Etapa 2.1, corregido acá)
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_organization_id_default_location_id_fkey" FOREIGN KEY ("organization_id", "default_location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_entry_unit_of_measure_i_fkey" FOREIGN KEY ("organization_id", "entry_unit_of_measure_id") REFERENCES "unit_of_measure"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "app_user"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_reverses_movement_id_fkey" FOREIGN KEY ("organization_id", "reverses_movement_id") REFERENCES "inventory_movement"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
