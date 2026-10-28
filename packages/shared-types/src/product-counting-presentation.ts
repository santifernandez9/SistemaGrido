/**
 * Presentaciones físicas de conteo por producto (Etapa 6.2.2, secciones
 * 14/15/16/17/18 del prompt) — ver docs/ETAPA-6.2.2-HARDENING-HITO1.md.
 * Genérico: cualquier `UnitOfMeasure` ya sembrada puede ser presentación de
 * cualquier producto SIN sabor, con su propio factor de conversión a la
 * cantidad canónica -- nunca "Unidad/Caja/Pack" hardcodeado. Un producto sin
 * ninguna presentación configurada sigue usando `Product.unitOfMeasureId`/
 * `unitsPerHandlingUnit` exactamente como antes (compatibilidad total).
 */

export interface ProductCountingPresentation {
  id: string;
  organizationId: string;
  productId: string;
  productName: string;
  unitOfMeasureId: string;
  unitOfMeasureName: string;
  /** String decimal > 0 -- unidades canónicas que representa UNA de esta presentación. */
  conversionFactorToCanonical: string;
  active: boolean;
  createdAt: string;
}

/** Body de `POST /api/products/:id/counting-presentations` (ADMIN). */
export interface CreateProductCountingPresentationInput {
  unitOfMeasureId: string;
  conversionFactorToCanonical: string;
}
