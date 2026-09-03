-- Etapa 2.1 — Integridad multi-organización en catálogo
-- Ver docs/ETAPA-2.1-INTEGRIDAD-MULTIORGANIZACION.md para el detalle completo.
--
-- Reemplaza las foreign keys de una sola columna entre entidades de catálogo
-- (todas tenant-scoped) por foreign keys COMPUESTAS que incluyen
-- organization_id, apoyadas en un UNIQUE(organization_id, id) agregado en
-- cada tabla padre. Esto hace que PostgreSQL mismo rechace, a nivel de
-- constraint, cualquier fila hija que referencie una fila padre de una
-- organización distinta -- ya no depende únicamente de la validación del
-- backend (apps/api/src/services/catalog.ts), que se mantiene sin cambios
-- como primera línea de defensa (mensajes de error claros para el usuario).
--
-- Si ya existieran filas con organization_id cruzado entre padre e hijo
-- (dato inconsistente previo), los ALTER TABLE ADD CONSTRAINT de abajo
-- FALLAN explícitamente (Postgres no puede crear la FK) y la migración se
-- detiene sin aplicar cambios parciales -- no hay ninguna lógica en este
-- script que borre o corrija datos existentes.

-- DropForeignKey
ALTER TABLE "category" DROP CONSTRAINT "category_parent_category_id_fkey";

-- DropForeignKey
ALTER TABLE "product" DROP CONSTRAINT "product_category_id_fkey";

-- DropForeignKey
ALTER TABLE "product" DROP CONSTRAINT "product_flavor_id_fkey";

-- DropForeignKey
ALTER TABLE "product" DROP CONSTRAINT "product_product_type_id_fkey";

-- DropForeignKey
ALTER TABLE "product" DROP CONSTRAINT "product_unit_of_measure_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "category_organization_id_id_key" ON "category"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "flavor_organization_id_id_key" ON "flavor"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_type_organization_id_id_key" ON "product_type"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_organization_id_id_key" ON "unit_of_measure"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_organization_id_parent_category_id_fkey" FOREIGN KEY ("organization_id", "parent_category_id") REFERENCES "category"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "category"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_product_type_id_fkey" FOREIGN KEY ("organization_id", "product_type_id") REFERENCES "product_type"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_unit_of_measure_id_fkey" FOREIGN KEY ("organization_id", "unit_of_measure_id") REFERENCES "unit_of_measure"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_flavor_id_fkey" FOREIGN KEY ("organization_id", "flavor_id") REFERENCES "flavor"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
