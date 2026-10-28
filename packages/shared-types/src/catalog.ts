/**
 * Tipos del módulo de Catálogo y Maestros (Etapa 2) — ver
 * docs/ETAPA-2-CATALOGO-MAESTROS.md. Sólo estructura de datos maestros
 * (categorías, tipos de producto, unidades de manejo, sabores, productos);
 * ningún tipo de movimiento/inventario/venta/BOM (eso es de una etapa futura).
 */

export const CATALOG_AUDIT_MODULES = ['CATALOG'] as const;
export type CatalogAuditModule = (typeof CATALOG_AUDIT_MODULES)[number];

export const CATALOG_AUDIT_ACTIONS = [
  'CATEGORY_CREATED',
  'CATEGORY_UPDATED',
  'CATEGORY_ACTIVATED',
  'CATEGORY_DEACTIVATED',
  'FLAVOR_CREATED',
  'FLAVOR_UPDATED',
  'FLAVOR_ACTIVATED',
  'FLAVOR_DEACTIVATED',
  'PRODUCT_CREATED',
  'PRODUCT_UPDATED',
  'PRODUCT_ACTIVATED',
  'PRODUCT_DEACTIVATED',
  /** Etapa 6.2.2 -- presentaciones físicas de conteo (sección 14/15 del prompt). */
  'PRODUCT_COUNTING_PRESENTATION_CREATED',
  'PRODUCT_COUNTING_PRESENTATION_DEACTIVATED',
] as const;
export type CatalogAuditAction = (typeof CATALOG_AUDIT_ACTIONS)[number];

/** Categoría/grupo de producto. `parentCategoryId` = subgrupo cuando corresponde (RN-002). */
export interface Category {
  id: string;
  organizationId: string;
  parentCategoryId: string | null;
  name: string;
  active: boolean;
  createdAt: string;
}

export interface CreateCategoryInput {
  name: string;
  parentCategoryId: string | null;
}

export interface UpdateCategoryInput {
  name?: string;
  parentCategoryId?: string | null;
  active?: boolean;
}

/** Tipo/línea de producto (ej. HELADO, INSUMO). Catálogo técnico, sólo lectura por API en Etapa 2. */
export interface ProductType {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/** Unidad de manejo (ej. UNIDAD, LATA, CAJA). Catálogo técnico, sólo lectura por API en Etapa 2. */
export interface UnitOfMeasure {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/** Sabor de helado (RF-003). */
export interface Flavor {
  id: string;
  organizationId: string;
  name: string;
  active: boolean;
  createdAt: string;
}

export interface CreateFlavorInput {
  name: string;
}

export interface UpdateFlavorInput {
  name?: string;
  active?: boolean;
}

/** Producto del catálogo (RF-001). Ver docs/ETAPA-2-CATALOGO-MAESTROS.md para cada campo. */
export interface Product {
  id: string;
  organizationId: string;
  code: string | null;
  name: string;
  categoryId: string;
  categoryName: string;
  productTypeId: string;
  productTypeName: string;
  unitOfMeasureId: string;
  unitOfMeasureName: string;
  unitsPerHandlingUnit: number;
  flavorId: string | null;
  flavorName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductInput {
  code: string | null;
  name: string;
  categoryId: string;
  productTypeId: string;
  unitOfMeasureId: string;
  unitsPerHandlingUnit: number;
  flavorId: string | null;
}

export interface UpdateProductInput {
  code?: string | null;
  name?: string;
  categoryId?: string;
  productTypeId?: string;
  unitOfMeasureId?: string;
  unitsPerHandlingUnit?: number;
  flavorId?: string | null;
  active?: boolean;
}
