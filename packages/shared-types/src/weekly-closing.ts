/**
 * Tipos del Cierre Semanal del núcleo operativo (Etapa 6) — ver
 * docs/ETAPA-6-CIERRE-SEMANAL.md. Consolida el estado de una semana
 * [periodStart..periodEnd] por ubicación después de que conteo físico
 * (Etapa 4), mermas/gastos (Etapa 4) y ventas importadas (Etapa 5) ya
 * están cargados. `inventory.ts` (`InventoryMovement`) sigue siendo la
 * única fuente de verdad de stock -- este módulo sólo consulta, compara y
 * genera un snapshot histórico; nunca reemplaza al ledger.
 */

export const WEEKLY_CLOSING_STATUSES = ['OPEN', 'CLOSED', 'REOPENED'] as const;
export type WeeklyClosingStatus = (typeof WEEKLY_CLOSING_STATUSES)[number];

export const WEEKLY_CLOSING_AUDIT_MODULES = ['WEEKLY_CLOSING'] as const;
export type WeeklyClosingAuditModule = (typeof WEEKLY_CLOSING_AUDIT_MODULES)[number];

export const WEEKLY_CLOSING_AUDIT_ACTIONS = [
  'WEEKLY_CLOSING_PREPARED',
  'WEEKLY_CLOSING_REVIEW_CONFIRMED',
  'WEEKLY_CLOSING_CLOSED',
  'WEEKLY_CLOSING_CLOSE_REJECTED',
  'WEEKLY_CLOSING_REOPENED',
  'GENERAL_WEEKLY_CLOSING_CLOSED',
] as const;
export type WeeklyClosingAuditAction = (typeof WEEKLY_CLOSING_AUDIT_ACTIONS)[number];

/**
 * Cierre semanal, tal como lo expone la API (sección 3 del prompt de
 * Etapa 6). `periodStart` es siempre un lunes, `periodEnd = periodStart + 6`
 * (documento del cliente, sección 24: "Período: lunes a domingo"). Los
 * campos `closedBy*`/`reopenedBy*` reflejan el evento MÁS RECIENTE -- el
 * historial completo de revisiones cerradas vive en
 * `WeeklyClosingItem[]`/`revision`, nunca se sobrescribe.
 */
export interface WeeklyClosing {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  /** Fecha ISO (YYYY-MM-DD), lunes. */
  periodStart: string;
  /** Fecha ISO (YYYY-MM-DD), domingo (= periodStart + 6). */
  periodEnd: string;
  status: WeeklyClosingStatus;
  /** 0 antes del primer cierre; se incrementa en cada `close` exitoso. */
  currentRevision: number;
  reviewConfirmedById: string | null;
  reviewConfirmedByName: string | null;
  reviewConfirmedAt: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  closedById: string | null;
  closedByName: string | null;
  closedAt: string | null;
  reopenedById: string | null;
  reopenedByName: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
}

/**
 * Checklist previo al cierre (sección 5 del prompt). `countSubmitted` es la
 * ÚNICA sub-condición verificada de forma automática e inequívoca --
 * existencia de un `InventoryCount` COMPLETED cuyo `weekStart` gobierna
 * este período (ver docs/ETAPA-6-CIERRE-SEMANAL.md, "Período semanal", para
 * la razón por la que `governingCountWeekStart = periodStart + 7 días`, NO
 * `periodStart`). Mermas/gastos/ventas se muestran como resúmenes
 * INFORMATIVOS -- una semana con 0 mermas o 0 gastos es válida y NUNCA
 * bloquea el cierre por ese motivo (sección 5: "no inventar 'debe haber al
 * menos una merma'"). Lo único que además del conteo bloquea el cierre es
 * que un ADMIN haya dado el gesto ÚNICO y consolidado de revisión
 * (`reviewConfirmedById`), que cubre todo el checklist a la vez.
 */
export interface WeeklyClosingChecklist {
  countSubmitted: boolean;
  governingCountId: string | null;
  /** Fecha ISO (YYYY-MM-DD) -- siempre calculable (`periodStart + 7 días`),
   * incluso si el conteo todavía no existe. */
  governingCountWeekStart: string;
  /** Estado del conteo gobernante si existe (`InventoryCountStatus` de
   * `shop-ops.ts`); null si todavía no se envió ningún conteo para esa
   * semana. */
  governingCountStatus: string | null;
  salesImportsTotal: number;
  salesImportsConfirmed: number;
  wastesTotal: number;
  variableExpensesTotal: number;
  reviewConfirmedById: string | null;
  reviewConfirmedByName: string | null;
  reviewConfirmedAt: string | null;
  /** Etapa 6.2, sección 11 del prompt -- productos con stock real sin costo
   * COST_WITH_TAX vigente resoluble. No vacío bloquea el cierre. */
  missingCostProducts: WeeklyClosingMissingCostProduct[];
  /** Etapa 6.2.2, secciones 7/8/10 del prompt (CONFIRMADO, corrige un
   * blocker real): toda diferencia distinta de cero del conteo gobernante
   * que todavía no tiene una resolución explícita válida -- un FALTANTE sin
   * `SHORTAGE_CONFIRMED` o un SOBRANTE sin `SURPLUS_RESOLVED`. No vacío
   * bloquea el cierre (una diferencia = 0 nunca aparece acá, no requiere
   * resolución). */
  pendingDifferenceResolutions: WeeklyClosingPendingDifferenceResolution[];
  /** = countSubmitted && reviewConfirmedById !== null && missingCostProducts.length === 0 && pendingDifferenceResolutions.length === 0 && status !== 'CLOSED'. */
  canClose: boolean;
}

/** Ver `WeeklyClosingChecklist.pendingDifferenceResolutions`. */
export interface WeeklyClosingPendingDifferenceResolution {
  productId: string;
  productName: string;
  /** String decimal -- la diferencia histórica (real - teórico) sin resolver. */
  difference: string;
  reason: 'SHORTAGE_NOT_CONFIRMED' | 'SURPLUS_NOT_RESOLVED';
}

/**
 * Línea teórico/real/diferencia por producto (sección 7/9 del prompt).
 * Mientras `WeeklyClosing.status` es OPEN/REOPENED, estas líneas se
 * calculan EN VIVO contra el `InventoryCountItem` del conteo gobernante
 * (nunca persistidas todavía) -- así el ADMIN puede revisar diferencias
 * antes de cerrar (sección 19: "6) ver resumen de conteo; 7) ver
 * diferencias"). Una vez CLOSED son las filas PERSISTIDAS e INMUTABLES de
 * `InventorySnapshotItem` para la revisión indicada por
 * `WeeklyClosingDetail.revision`.
 */
export interface WeeklyClosingItem {
  productId: string;
  productName: string;
  /** String decimal (mismo criterio que el ledger, Etapa 3.1). */
  quantityTheoretical: string;
  quantityReal: string;
  /** = quantityReal - quantityTheoretical. */
  difference: string;
  /** Id del movimiento COUNT_CORRECTION generado por el cierre para esta
   * línea. Siempre null mientras no está CLOSED, y también null (aun
   * CLOSED) cuando `difference` era '0' -- nunca se genera un ajuste sin
   * diferencia real (sección 8 del prompt). */
  countCorrectionMovementId: string | null;
  /** Valorización (Etapa 6.2, sección 10 del prompt) -- costo unitario CON
   * IVA vigente y valor total, congelados al momento del `close` (nunca
   * recalculados por un import de precios posterior). `null` mientras no
   * está CLOSED (vista previa) o cuando el producto no requirió valuación
   * (`quantityReal = '0'`). */
  unitCostWithTax: string | null;
  totalValue: string | null;
  priceValueId: string | null;
}

/** Un producto con stock real (Etapa 6.2, sección 11 del prompt) sin costo
 * COST_WITH_TAX vigente resoluble -- bloquea el cierre hasta que un ADMIN
 * resuelva el mapeo o importe el costo faltante. Nunca se inventa costo=0. */
export interface WeeklyClosingMissingCostProduct {
  productId: string;
  productName: string;
  quantityReal: string;
  /** Motivo específico: sin mapeo activo a ninguna PriceReference
   * COST_WITH_TAX, o con mapeo pero sin ningún PriceValue vigente todavía. */
  reason: 'NO_MAPPING' | 'NO_VIGENT_VALUE';
}

/**
 * Vista completa de un cierre (checklist + comparación teórico/real) --
 * misma forma de respuesta se reutiliza antes y después de cerrar (sección
 * 19 del prompt: la pantalla de cierre muestra lo mismo, sólo que antes de
 * cerrar los números son un cálculo en vivo y después son el snapshot
 * congelado).
 */
export interface WeeklyClosingDetail {
  closing: WeeklyClosing;
  checklist: WeeklyClosingChecklist;
  /** `currentRevision` mientras OPEN/REOPENED (vista previa, no persistida
   * todavía); la revisión CLOSED más reciente una vez CLOSED. */
  revision: number;
  items: WeeklyClosingItem[];
}

/** Body de `POST /api/weekly-closings` (crear/preparar el cierre de una
 * ubicación y período -- operación get-or-create, protegida por el UNIQUE
 * (organizationId, locationId, periodStart) del schema). */
export interface PrepareWeeklyClosingInput {
  locationId: string;
  /** Fecha ISO (YYYY-MM-DD), debe caer en lunes. */
  periodStart: string;
}

/** Body de `POST /api/weekly-closings/:id/close` (sección 13 del prompt:
 * idempotencia obligatoria del cierre definitivo). */
export interface CloseWeeklyClosingInput {
  idempotencyKey: string;
}

/** Body de `POST /api/weekly-closings/:id/reopen` -- motivo obligatorio
 * (sección 12 del prompt: operación sensible). */
export interface ReopenWeeklyClosingInput {
  reason: string;
}

export interface WeeklyClosingFilters {
  locationId?: string;
  status?: WeeklyClosingStatus;
}

// ---------------------------------------------------------------------------
// Cierre semanal GENERAL (Etapa 6.2, sección 12 del prompt, CONFIRMADO: "la
// semana cierra cuando TODAS las heladerías requeridas terminaron su
// conteo"). No reemplaza los `WeeklyClosing` por ubicación de arriba --
// agrega la vista/estado a NIVEL SEMANA.

export const GENERAL_WEEKLY_CLOSING_STATUSES = ['OPEN', 'CLOSED'] as const;
export type GeneralWeeklyClosingStatus = (typeof GENERAL_WEEKLY_CLOSING_STATUSES)[number];

/** Estado de una heladería REQUERIDA (`Location.active && type ===
 * 'ICE_CREAM_SHOP'`, nunca una lista hardcodeada) dentro del cierre general. */
export interface GeneralWeeklyClosingLocationStatus {
  locationId: string;
  locationName: string;
  weeklyClosingId: string | null;
  weeklyClosingStatus: WeeklyClosingStatus | null;
  /** true sólo cuando su `WeeklyClosing` está CLOSED -- REOPENED cuenta como
   * "no lista" hasta que se vuelva a cerrar. */
  ready: boolean;
}

export interface GeneralWeeklyClosing {
  id: string | null;
  organizationId: string;
  /** Fecha ISO (YYYY-MM-DD), lunes. */
  periodStart: string;
  periodEnd: string;
  status: GeneralWeeklyClosingStatus;
  closedById: string | null;
  closedByName: string | null;
  closedAt: string | null;
  locations: GeneralWeeklyClosingLocationStatus[];
  /** = todas las `locations` con `ready === true`. */
  canClose: boolean;
}

export interface CloseGeneralWeeklyClosingInput {
  idempotencyKey: string;
}
