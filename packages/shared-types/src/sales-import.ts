/**
 * Tipos del Importador de Ventas (Etapa 5) — ver
 * docs/ETAPA-5-IMPORTADOR-VENTAS.md. Fuente real inspeccionada: reporte "Mix
 * de Ventas" del POS, exportado con el filtro "Precios: Desagrupados" (la
 * variante "Agrupados" fusiona líneas y pierde la identificación de
 * Canje/promoción por línea, ver el doc). Un producto se identifica por el
 * código numérico `articulo` del POS -- nunca por su descripción de texto.
 *
 * Este importador sólo agrega hechos nuevos al ledger ya existente de
 * Etapa 3 (movimientos SALE y BOM_CONSUMPTION) -- no reabre `inventory.ts`
 * ni `shop-ops.ts`.
 */

export const SALES_IMPORT_SOURCES = ['MIX_VENTAS'] as const;
export type SalesImportSource = (typeof SALES_IMPORT_SOURCES)[number];

/**
 * Estados del import (sección 15 del prompt de Etapa 5). Una vez CONFIRMED,
 * sus efectos (Sale, movimientos SALE/BOM_CONSUMPTION, auditoría) son
 * inmutables -- una corrección futura es una reversa trazable, nunca una
 * edición silenciosa.
 */
export const SALES_IMPORT_STATUSES = [
  'UPLOADED',
  'PREVIEW_READY',
  'BLOCKED',
  'CONFIRMED',
  'FAILED',
] as const;
export type SalesImportStatus = (typeof SALES_IMPORT_STATUSES)[number];

export const SALES_IMPORT_ROW_STATUSES = ['VALID', 'ERROR'] as const;
export type SalesImportRowStatus = (typeof SALES_IMPORT_ROW_STATUSES)[number];

export const SALES_IMPORT_AUDIT_MODULES = ['SALES_IMPORT'] as const;
export type SalesImportAuditModule = (typeof SALES_IMPORT_AUDIT_MODULES)[number];

export const SALES_IMPORT_AUDIT_ACTIONS = [
  'SALES_IMPORT_UPLOADED',
  'SALES_IMPORT_ALREADY_IMPORTED',
  'SALES_IMPORT_BLOCKED',
  'SALES_IMPORT_FAILED',
  'SALES_IMPORT_CONFIRMED',
  'SALES_IMPORT_PRODUCT_ALIAS_CONFIRMED',
  'SALES_IMPORT_BOM_ITEM_CREATED',
  'SALES_IMPORT_BOM_ITEM_UPDATED',
] as const;
export type SalesImportAuditAction = (typeof SALES_IMPORT_AUDIT_ACTIONS)[number];

/**
 * Fila ya parseada y validada, tal como la expone la API. El mapeo a
 * producto (`resolvedProductId`/`resolvedProductName`) se resuelve EN VIVO
 * contra `ProductAlias` en cada consulta -- nunca se cachea en la fila --
 * así un alias creado después de la subida se toma en cuenta sin volver a
 * subir el archivo (sección 7 del prompt: "si no está mapeado, no impactar
 * stock" combinado con "confirmar un alias nuevo antes de impactar").
 */
export interface SalesImportRow {
  id: string;
  rowNumber: number;
  rawArticleCode: string;
  rawDescription: string;
  rawGroup: string;
  /** String decimal -- misma convención que el ledger (Etapa 3.1). */
  quantity: string;
  /** String decimal (NUMERIC(14,2)) -- importe REAL de la línea, nunca un precio de lista. */
  amount: string;
  isPromotion: boolean;
  isCanje: boolean;
  promotionCode: string | null;
  unitPriceAvg: string | null;
  bultos: string | null;
  kilos: string | null;
  pctOfTotal: string | null;
  status: SalesImportRowStatus;
  errorMessage: string | null;
  /** Resuelto en vivo contra ProductAlias(source, rawArticleCode). */
  resolvedProductId: string | null;
  resolvedProductName: string | null;
}

/**
 * Import de ventas (archivo subido), tal como lo expone la API. `fileHash`
 * es un SHA-256 del contenido exacto del archivo -- la idempotencia de
 * subida (sección 8 del prompt) se apoya en un índice único por
 * (organización, ubicación, fileHash), nunca en el nombre del archivo.
 */
export interface SalesImport {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  source: SalesImportSource;
  originalFilename: string;
  fileHash: string;
  /** Fechas ISO (YYYY-MM-DD) del rango que el propio reporte declara. */
  periodStart: string;
  periodEnd: string;
  status: SalesImportStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  /** String decimal -- suma de `quantity` de las filas válidas. */
  totalQuantity: string;
  /** String decimal -- suma de `amount` de las filas válidas. */
  totalAmount: string;
  /** Total que el propio archivo declara en su fila "Total General", si existe. */
  fileStatedTotal: string | null;
  blockedReason: string | null;
  failedReason: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  confirmedById: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  /** true cuando esta respuesta corresponde a un import YA existente (mismo
   * archivo exacto reimportado) en vez de uno nuevo recién creado. */
  alreadyImported?: boolean;
}

/** Resumen de mapeo de productos mostrado en el preview (sección 6 del prompt). */
export interface SalesImportProductMappingSummary {
  productId: string;
  productName: string;
  rowCount: number;
}

export interface SalesImportUnmappedCodeSummary {
  rawArticleCode: string;
  rawDescription: string;
  rowCount: number;
}

/**
 * Preview completo de un import (sección 6 del prompt: "filas
 * válidas/productos reconocidos/productos sin mapear/errores/totales").
 * Nunca altera stock -- es sólo lectura, aun para un import ya CONFIRMED
 * (en ese caso el preview muestra el resultado final, no un cálculo nuevo).
 */
export interface SalesImportPreview {
  import: SalesImport;
  rows: SalesImportRow[];
  mappedProducts: SalesImportProductMappingSummary[];
  unmappedCodes: SalesImportUnmappedCodeSummary[];
  /** true si hay al menos un código sin mapear entre las filas válidas -- no
   * bloquea la confirmación (sección 7: filas sin mapear nunca impactan
   * stock, pero el resto sí puede confirmarse). */
  hasUnmappedProducts: boolean;
  /**
   * Números de fila que comparten exactamente (código de artículo, cantidad,
   * importe, código de promoción) con al menos otra fila del mismo import --
   * señal informativa de "posible duplicado interno" (sección 6/13 del
   * prompt), calculada en vivo sobre las filas ya guardadas. Nunca bloquea
   * la confirmación por sí sola: dos líneas idénticas pueden ser dos ventas
   * reales coincidentes (mismo producto, misma cantidad, mismo precio).
   */
  potentialDuplicateRowNumbers: number[];
  /** true si `status === 'BLOCKED'` -- la confirmación está deshabilitada
   * hasta subir un archivo corregido (sección 13 del prompt). */
  canConfirm: boolean;
}

/** Body de `POST /api/sales-imports/:id/confirm` (sección 9: idempotencia de confirmación). */
export interface ConfirmSalesImportInput {
  idempotencyKey: string;
}

/** Filtros del listado de imports. */
export interface SalesImportFilters {
  locationId?: string;
  status?: SalesImportStatus;
}

/**
 * Mapeo ADMIN-confirmado entre un código externo del POS y un Product del
 * catálogo (sección 7 del prompt). Nunca se crea sola/automáticamente.
 */
export interface ProductAlias {
  id: string;
  source: SalesImportSource;
  externalCode: string;
  externalDescription: string | null;
  productId: string;
  productName: string;
  confirmedById: string;
  confirmedByName: string;
  createdAt: string;
}

export interface CreateProductAliasInput {
  source: SalesImportSource;
  externalCode: string;
  externalDescription?: string;
  productId: string;
}

/**
 * Receta/BOM (sección 18 del prompt: "las recetas se gestionan en base de
 * datos, nunca hardcodeadas"). `quantityPerUnit` está en unidad CANÓNICA del
 * componente por cada unidad CANÓNICA del producto vendido.
 */
export interface BillOfMaterialItem {
  id: string;
  productId: string;
  productName: string;
  componentProductId: string;
  componentProductName: string;
  /** String decimal (NUMERIC(14,6)) -- permite insumos fraccionarios finos (ej. gramos de tapa). */
  quantityPerUnit: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBillOfMaterialItemInput {
  productId: string;
  componentProductId: string;
  quantityPerUnit: string;
  active?: boolean;
}

export interface UpdateBillOfMaterialItemInput {
  quantityPerUnit?: string;
  active?: boolean;
}

/**
 * Venta CONFIRMADA (hecho inmutable). `movementId` referencia el movimiento
 * SALE que esta venta generó en el ledger de Etapa 3; los eventuales
 * movimientos BOM_CONSUMPTION de esta venta se consultan vía
 * `InventoryMovement.sourceDocumentType = 'SALE'` + `sourceDocumentId = Sale.id`
 * (mismo mecanismo reservado desde Etapa 3, ver `inventory.ts`).
 */
export interface Sale {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  salesImportId: string;
  salesImportRowId: string;
  productId: string;
  productName: string;
  quantity: string;
  amountReal: string;
  isPromotion: boolean;
  isCanje: boolean;
  occurredAt: string;
  movementId: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
}
