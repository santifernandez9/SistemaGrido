-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_category_id" UUID,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_type" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_of_measure" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flavor" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "flavor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "product_type_id" UUID NOT NULL,
    "unit_of_measure_id" UUID NOT NULL,
    "units_per_handling_unit" INTEGER NOT NULL DEFAULT 1,
    "flavor_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_organization_id_idx" ON "category"("organization_id");

-- CreateIndex
CREATE INDEX "category_parent_category_id_idx" ON "category"("parent_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_organization_id_parent_category_id_name_key" ON "category"("organization_id", "parent_category_id", "name");

-- CreateIndex
CREATE INDEX "product_type_organization_id_idx" ON "product_type"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_type_organization_id_code_key" ON "product_type"("organization_id", "code");

-- CreateIndex
CREATE INDEX "unit_of_measure_organization_id_idx" ON "unit_of_measure"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_organization_id_code_key" ON "unit_of_measure"("organization_id", "code");

-- CreateIndex
CREATE INDEX "flavor_organization_id_idx" ON "flavor"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "flavor_organization_id_name_key" ON "flavor"("organization_id", "name");

-- CreateIndex
CREATE INDEX "product_organization_id_idx" ON "product"("organization_id");

-- CreateIndex
CREATE INDEX "product_category_id_idx" ON "product"("category_id");

-- CreateIndex
CREATE INDEX "product_flavor_id_idx" ON "product"("flavor_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_organization_id_code_key" ON "product"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_type" ADD CONSTRAINT "product_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flavor" ADD CONSTRAINT "flavor_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_unit_of_measure_id_fkey" FOREIGN KEY ("unit_of_measure_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_flavor_id_fkey" FOREIGN KEY ("flavor_id") REFERENCES "flavor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint (Etapa 2 sección 11 "integridad de datos": valores positivos)
-- Prisma no expresa CHECK constraints de forma declarativa en el schema; se agrega
-- a mano en la migración generada, mismo criterio ya documentado en Etapa 0
-- (sección 17.1, "customizing migrations").
ALTER TABLE "product" ADD CONSTRAINT "product_units_per_handling_unit_positive" CHECK ("units_per_handling_unit" > 0);
