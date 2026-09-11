/**
 * Tipos del modelo histórico de precios/costos (Etapa 6.2) — ver
 * docs/ETAPA-6.2-CIERRE-INTEGRAL.md. Construido exclusivamente contra los
 * dos archivos reales inspeccionados: "Lista_Precio_Costo.xlsx" (hoja
 * "Precio Helacor" -- descripción / "Precio S/ IVA" / "Precio C/ IVA", sin
 * código de artículo) y "Lista_Valor_venta_de_SEP2026.xlsx" (hoja "Precios
 * Grido" -- descripción / precio único). Ninguno trae vigencia estructurada
 * -- `effectiveFrom` siempre lo indica el ADMIN al confirmar, nunca se
 * infiere del rótulo de período libre del archivo.
 */

export const PRICE_TYPES = ['COST_WITH_TAX', 'SALE_PRICE'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const PRICE_LIST_SOURCES = ['HELACOR_COST_LIST', 'HELACOR_SALE_PRICE_LIST'] as const;
export type PriceListSource = (typeof PRICE_LIST_SOURCES)[number];

/** Cada fuente produce siempre el mismo `priceType` (1:1, constante). */
export const PRICE_TYPE_BY_SOURCE: Record<PriceListSource, PriceType> = {
  HELACOR_COST_LIST: 'COST_WITH_TAX',
  HELACOR_SALE_PRICE_LIST: 'SALE_PRICE',
};

export const PRICE_LIST_IMPORT_STATUSES = [
  'UPLOADED',
  'PREVIEW_READY',
  'CONFIRMED',
  'FAILED',
] as const;
export type PriceListImportStatus = (typeof PRICE_LIST_IMPORT_STATUSES)[number];

export const PRICE_LIST_ROW_STATUSES = ['VALID', 'ERROR'] as const;
export type PriceListRowStatus = (typeof PRICE_LIST_ROW_STATUSES)[number];

export const PRICE_LIST_AUDIT_MODULES = ['PRICE_LIST'] as const;
export type PriceListAuditModule = (typeof PRICE_LIST_AUDIT_MODULES)[number];

export const PRICE_LIST_AUDIT_ACTIONS = [
  'PRICE_LIST_IMPORT_UPLOADED',
  'PRICE_LIST_IMPORT_ALREADY_IMPORTED',
  'PRICE_LIST_IMPORT_FAILED',
  'PRICE_LIST_IMPORT_CONFIRMED',
  'PRICE_REFERENCE_PRODUCT_MAPPING_CONFIRMED',
  'PRICE_REFERENCE_PRODUCT_MAPPING_DEACTIVATED',
] as const;
export type PriceListAuditAction = (typeof PRICE_LIST_AUDIT_ACTIONS)[number];

export interface PriceListImport {
  id: string;
  organizationId: string;
  source: PriceListSource;
  priceType: PriceType;
  originalFilename: string;
  fileHash: string;
  /** Rótulo de período tal cual aparece en el archivo (ej. "Septiembre
   * 2026") -- informativo, nunca una fecha. */
  rawPeriodLabel: string | null;
  status: PriceListImportStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  failedReason: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  /** Fecha ISO (YYYY-MM-DD) que el ADMIN indicó al confirmar. NULL hasta la
   * confirmación. */
  effectiveFrom: string | null;
  confirmedById: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  /** true cuando esta respuesta corresponde a un import YA existente (mismo
   * archivo exacto reimportado). */
  alreadyImported?: boolean;
}

export interface PriceListImportRow {
  id: string;
  rowNumber: number;
  rawLabel: string;
  rawCategory: string | null;
  /** String decimal, sólo presente en archivos de costo. */
  rawValueWithoutTax: string | null;
  /** String decimal -- el valor efectivamente usado. */
  rawValueWithTax: string | null;
  status: PriceListRowStatus;
  errorMessage: string | null;
  /** Resuelto EN VIVO contra `PriceReference(priceType, rawLabel)` -- null
   * si sería una referencia NUEVA (todavía no existe con ese label exacto). */
  existingPriceReferenceId: string | null;
  /** true si la referencia (nueva o existente) ya tiene al menos un mapeo
   * ACTIVO a un producto del catálogo. */
  isMapped: boolean;
}

/** Preview de un import de precios/costos -- SÓLO LECTURA, nunca crea
 * `PriceReference`/`PriceValue` (sección 6 del prompt de Etapa 5, mismo
 * criterio reutilizado acá). */
export interface PriceListImportPreview {
  import: PriceListImport;
  rows: PriceListImportRow[];
  /** Cuántas filas válidas corresponden a una etiqueta ya conocida vs. una
   * nueva -- puramente informativo para la revisión del ADMIN. */
  newReferenceCount: number;
  existingReferenceCount: number;
  unmappedReferenceCount: number;
  canConfirm: boolean;
}

/** Body de `POST /api/price-list-imports/:id/confirm` -- `effectiveFrom`
 * es OBLIGATORIO acá (nunca al subir, sección 9 del prompt: "no inventar
 * columnas/vigencia"). */
export interface ConfirmPriceListImportInput {
  idempotencyKey: string;
  /** Fecha ISO (YYYY-MM-DD) indicada explícitamente por el ADMIN. */
  effectiveFrom: string;
}

export interface PriceListImportFilters {
  source?: PriceListSource;
  status?: PriceListImportStatus;
}

/** Referencia estable de precio/costo (sección 7/8 del prompt). */
export interface PriceReference {
  id: string;
  priceType: PriceType;
  label: string;
  sourceCategory: string | null;
  active: boolean;
  /** Valor VIGENTE hoy (mayor `effectiveFrom <= hoy`), null si nunca se
   * importó ningún valor todavía. */
  currentValue: string | null;
  currentValueEffectiveFrom: string | null;
  mappedProductCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PriceValue {
  id: string;
  priceReferenceId: string;
  priceType: PriceType;
  value: string;
  effectiveFrom: string;
  priceListImportId: string;
  originalFilename: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
}

export interface PriceReferenceFilters {
  priceType?: PriceType;
  /** Filtra sólo referencias sin ningún mapeo activo (sección 8 del prompt:
   * "reportar reconocidos/mapeados/sin mapear"). */
  onlyUnmapped?: boolean;
}

/** Mapeo ADMIN-confirmado entre una `PriceReference` y UNO O VARIOS
 * `Product` (sección 8 del prompt: nunca 1:1 forzado). */
export interface PriceReferenceProductMapping {
  id: string;
  priceReferenceId: string;
  priceReferenceLabel: string;
  priceType: PriceType;
  productId: string;
  productName: string;
  active: boolean;
  confirmedById: string;
  confirmedByName: string;
  createdAt: string;
}

export interface CreatePriceReferenceProductMappingInput {
  priceReferenceId: string;
  productId: string;
}

/** Precio/costo vigente resuelto para UN producto del catálogo a una fecha
 * dada, a través de su mapeo activo -- usado por la UI de valorización y
 * por `resolveValuationForProducts` (weekly-closing.ts). */
export interface ProductPriceResolution {
  productId: string;
  productName: string;
  priceType: PriceType;
  /** null cuando el producto no tiene mapeo activo, o el mapeo existe pero
   * no hay ningún `PriceValue` vigente a la fecha consultada -- nunca se
   * inventa un valor (sección 11 del prompt). */
  value: string | null;
  priceValueId: string | null;
  priceReferenceId: string | null;
  priceReferenceLabel: string | null;
  effectiveFrom: string | null;
}
