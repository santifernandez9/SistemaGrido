-- Etapa 6.2.2 (hardening final del Hito 1) -- migración puramente ADITIVA:
-- una columna nueva en inventory_count_item (snapshot histórico del
-- desglose por presentación) y una tabla nueva, product_counting_presentation
-- (secciones 14/15/16 del prompt: "Unidad/Caja/Pack" observadas en las
-- planillas reales, genérico -- ver el comentario extenso de
-- ProductCountingPresentation en schema.prisma). Ninguna migración
-- histórica se modifica; ningún dato existente se toca.

-- AlterTable
ALTER TABLE "inventory_count_item" ADD COLUMN     "presentation_breakdown" JSONB;

-- CreateTable
CREATE TABLE "product_counting_presentation" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_of_measure_id" UUID NOT NULL,
    "conversion_factor_to_canonical" DECIMAL(14,3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_counting_presentation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_counting_presentation_organization_id_product_id_idx" ON "product_counting_presentation"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_counting_presentation_organization_id_product_id_un_key" ON "product_counting_presentation"("organization_id", "product_id", "unit_of_measure_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_counting_presentation_organization_id_id_key" ON "product_counting_presentation"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "product_counting_presentation" ADD CONSTRAINT "product_counting_presentation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_counting_presentation" ADD CONSTRAINT "product_counting_presentation_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "product"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_counting_presentation" ADD CONSTRAINT "product_counting_presentation_organization_id_unit_of_meas_fkey" FOREIGN KEY ("organization_id", "unit_of_measure_id") REFERENCES "unit_of_measure"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK agregado a mano (Prisma no expresa CHECK declarativamente) -- mismo
-- patrón que el resto del proyecto desde Etapa 2.
ALTER TABLE "product_counting_presentation" ADD CONSTRAINT "product_counting_presentation_conversion_factor_check" CHECK ("conversion_factor_to_canonical" > 0);
