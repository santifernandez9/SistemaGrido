import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import {
  OPEN_CONTAINER_FRACTIONS,
  type InventoryCount,
  type InventoryCountDraftItem,
  type InventoryCountItemResult,
  type OpenContainerFraction,
  type PresentationQuantityInput,
  type Product,
  type ProductCountingPresentation,
} from '@sistema-grido/shared-types';
import {
  clearCountDraft,
  countDraftId,
  loadCountDraft,
  saveCountDraft,
} from '../lib/countDraftStore.js';
import { currentWeekStartISO } from '../lib/week.js';
import { newIdempotencyKey } from '../lib/id.js';

const FRACTION_LABELS: Record<OpenContainerFraction, string> = {
  FULL: 'Llena',
  THREE_QUARTERS: '3/4',
  HALF: '1/2',
  QUARTER: '1/4',
  NEARLY_EMPTY: 'Casi vacía',
};

type Phase = 'loading' | 'counting' | 'recounting' | 'done' | 'blocked';

function toNumberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Un ítem "cuenta" para el progreso/envío apenas tiene alguna cantidad
 * cargada -- las 3 líneas del papel real (Salón cerrada/abierta, Depósito)
 * son independientes entre sí (RN, sección 4 del prompt de Etapa 6.2.1).
 *
 * Etapa 6.2.2, secciones 3/14-18 del prompt: para un producto con
 * presentaciones de conteo configuradas (`hasPresentations`), "Cerrados"
 * nunca se usa (el backend lo rechaza) -- ahí lo que cuenta es haber
 * cargado al menos una presentación (`item.presentations` no vacío). Un
 * campo dejado VACÍO nunca se interpreta como cero -- sólo un "0"
 * efectivamente tipeado (que `toNumberOrUndefined` conserva como `0`,
 * distinto de `undefined`) cuenta como "contado explícitamente en cero".
 */
function isItemCounted(
  item: InventoryCountDraftItem | undefined,
  hasPresentations: boolean,
): boolean {
  if (!item) return false;
  if (hasPresentations) {
    return (item.presentations?.length ?? 0) > 0;
  }
  return (
    item.closedUnits !== undefined ||
    item.openUnits !== undefined ||
    item.depositoClosedUnits !== undefined
  );
}

/** Agrupa las presentaciones activas de la organización por producto --
 * una sola llamada (`GET /api/products/counting-presentations`, Etapa
 * 6.2.2) en vez de una por producto contra un catálogo de ~200 productos. */
function groupPresentationsByProduct(
  presentations: ProductCountingPresentation[],
): Map<string, ProductCountingPresentation[]> {
  const byProduct = new Map<string, ProductCountingPresentation[]>();
  for (const presentation of presentations) {
    const list = byProduct.get(presentation.productId) ?? [];
    list.push(presentation);
    byProduct.set(presentation.productId, list);
  }
  return byProduct;
}

/** Sólo un sabor de helado (`flavorId !== null`) tiene la 3ra línea
 * "Depósito" del papel real -- nunca un insumo/producto cerrado. */
function isFlavorProduct(product: Product): boolean {
  return product.flavorId !== null;
}

/** El campo "Sueltos" es redundante cuando la unidad de manejo YA es la
 * unidad atómica (`unitsPerHandlingUnit === 1`) para un producto que no es
 * sabor -- ahí sólo "Cerrados" tiene sentido. Todo sabor, en cambio, siempre
 * tiene sueltos/abiertos (la 2da línea del papel real, "Salón - abierta"). */
function showsLooseField(product: Product): boolean {
  return product.unitsPerHandlingUnit > 1 || isFlavorProduct(product);
}

interface CategoryGroup {
  category: string;
  products: Product[];
}

/** Agrupa por `categoryName` tal cual viene del catálogo -- nunca una lista
 * fija en el código: un rubro nuevo cargado por un admin aparece solo, sin
 * tocar esta pantalla (sección 1 del prompt de Etapa 6.2.1). */
function groupByCategory(products: Product[]): CategoryGroup[] {
  const byCategory = new Map<string, Product[]>();
  for (const product of products) {
    const list = byCategory.get(product.categoryName) ?? [];
    list.push(product);
    byCategory.set(product.categoryName, list);
  }
  return [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      products: [...list].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }))
    .sort((a, b) => a.category.localeCompare(b.category, 'es'));
}

/**
 * Conteo físico semanal (RF-012/RF-020), CIEGO (RN-012): en ningún momento
 * mientras se cuenta o se recuenta se pide ni se muestra el stock teórico ni
 * la diferencia -- esta pantalla nunca llama a `/api/inventory/stock` ni
 * muestra esos campos de la respuesta del envío. El borrador vive en
 * IndexedDB (`../lib/countDraftStore.ts`, RN-013: "sobrevivir a un corte de
 * conexión, recarga accidental o cierre de la app") y sólo se borra después
 * de que el backend confirma el envío -- ver docs/ETAPA-4-APP-HELADERIA.md,
 * "Autoguardado".
 *
 * Etapa 6.2.1: adaptada a las planillas de papel reales del cliente --
 * agrupada por rubro (`categoryName`) y, para cada sabor de helado, con la
 * 3ra línea "Depósito" (cámara propia de esa misma heladería) además de
 * "Salón - cerrada/abierta". Todo lo que se agrupa o etiqueta sale del
 * catálogo (`Product`), nunca de un nombre hardcodeado.
 */
export function CountPage() {
  const { user, api } = useAuth();
  const locationId = user?.defaultLocationId ?? null;
  const weekStart = useMemo(() => currentWeekStartISO(), []);
  const draftId = locationId ? countDraftId(locationId, weekStart) : null;

  const [phase, setPhase] = useState<Phase>('loading');
  const [products, setProducts] = useState<Product[]>([]);
  const [presentationsByProduct, setPresentationsByProduct] = useState<
    Map<string, ProductCountingPresentation[]>
  >(new Map());
  const [items, setItems] = useState<Record<string, InventoryCountDraftItem>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InventoryCount | null>(null);

  const idempotencyKeyRef = useRef<string>('');
  const loadedRef = useRef(false);

  // Carga inicial: catálogo + presentaciones de conteo activas (Etapa 6.2.2,
  // en una sola llamada para todo el catálogo) + borrador ya guardado (si lo
  // hay) -- restaura la sesión de conteo tal como quedó, sin perder nada de
  // lo ya tipeado.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!locationId || !draftId) {
        setPhase('blocked');
        return;
      }
      try {
        const [productList, presentationList, draft] = await Promise.all([
          api.get<Product[]>('/api/products'),
          api.get<ProductCountingPresentation[]>('/api/products/counting-presentations'),
          loadCountDraft(draftId),
        ]);
        if (cancelled) return;
        setProducts(productList.filter((p) => p.active));
        setPresentationsByProduct(groupPresentationsByProduct(presentationList));
        if (draft) {
          setItems(draft.items);
          idempotencyKeyRef.current = draft.idempotencyKey;
        } else {
          idempotencyKeyRef.current = newIdempotencyKey();
          await saveCountDraft({
            id: draftId,
            locationId,
            weekStart,
            idempotencyKey: idempotencyKeyRef.current,
            items: {},
            updatedAt: new Date().toISOString(),
          });
        }
        loadedRef.current = true;
        setPhase('counting');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : 'No se pudo cargar el conteo');
          setPhase('blocked');
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, draftId, locationId, weekStart]);

  // Autoguardado: cada cambio se persiste en IndexedDB de inmediato -- nunca
  // se espera al envío para no perder nada ante un corte o un cierre.
  // Todos los ítems viven en un único estado (no por sección/categoría), así
  // que cambiar de sección nunca pierde lo ya tipeado en otra.
  useEffect(() => {
    if (!loadedRef.current || !draftId || !locationId) return;
    void saveCountDraft({
      id: draftId,
      locationId,
      weekStart,
      idempotencyKey: idempotencyKeyRef.current,
      items,
      updatedAt: new Date().toISOString(),
    });
  }, [items, draftId, locationId, weekStart]);

  const updateItem = useCallback((productId: string, patch: Partial<InventoryCountDraftItem>) => {
    setItems((current) => {
      const existing = current[productId] ?? { productId };
      return { ...current, [productId]: { ...existing, ...patch } };
    });
  }, []);

  const hasPresentations = useCallback(
    (productId: string) => (presentationsByProduct.get(productId)?.length ?? 0) > 0,
    [presentationsByProduct],
  );

  const grouped = useMemo(() => groupByCategory(products), [products]);
  // Etapa 6.2.2, secciones 3/4 del prompt (BLOCKER): el universo obligatorio
  // del conteo es EXACTAMENTE el catálogo activo cargado más arriba (mismo
  // criterio que `submitInventoryCount` en el backend, que valida esto de
  // forma AUTORITATIVA -- esto acá es sólo para guiar a la empleada antes de
  // intentar enviar, nunca la validación real).
  const missingProducts = useMemo(
    () => products.filter((p) => !isItemCounted(items[p.id], hasPresentations(p.id))),
    [products, items, hasPresentations],
  );
  const countedTotal = products.length - missingProducts.length;
  const categoriesWithMissing = useMemo(() => {
    const missingIds = new Set(missingProducts.map((p) => p.id));
    return grouped
      .map((group) => ({
        category: group.category,
        missing: group.products.filter((p) => missingIds.has(p.id)).length,
      }))
      .filter((g) => g.missing > 0);
  }, [grouped, missingProducts]);

  const categoryRefs = useRef<Map<string, HTMLDetailsElement>>(new Map());
  const registerCategoryRef = useCallback((category: string, el: HTMLDetailsElement | null) => {
    if (el) categoryRefs.current.set(category, el);
    else categoryRefs.current.delete(category);
  }, []);
  function jumpToCategory(category: string) {
    const el = categoryRefs.current.get(category);
    if (!el) return;
    el.open = true;
    // `scrollIntoView` no existe en jsdom (entorno de test) -- se llama de
    // forma defensiva, nunca es esencial para el comportamiento real.
    el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  async function handleSubmit() {
    setError(null);
    // Mismo chequeo que el backend hace de forma AUTORITATIVA
    // (`submitInventoryCount`): nunca se envía si falta contar algún
    // producto activo del catálogo -- acá sólo se anticipa para no gastar un
    // viaje al servidor, el botón ya queda deshabilitado mientras falte algo.
    if (missingProducts.length > 0) {
      setError(
        `Faltan ${missingProducts.length} producto(s) por contar antes de poder enviar el conteo.`,
      );
      return;
    }
    const submittedItems = Object.values(items).filter((item) =>
      isItemCounted(item, hasPresentations(item.productId)),
    );
    const validationError = findMissingFraction(products, submittedItems);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!locationId || !draftId) return;

    setSubmitting(true);
    try {
      const created = await api.post<InventoryCount>('/api/shop/counts', {
        locationId,
        weekStart,
        items: submittedItems,
        idempotencyKey: idempotencyKeyRef.current,
      });
      await clearCountDraft(draftId);
      setResult(created);
      setPhase(created.status === 'RECOUNT_REQUIRED' ? 'recounting' : 'done');
    } catch (err) {
      // El borrador NO se borra: sigue en IndexedDB con la misma
      // idempotencyKey, listo para reintentar sin duplicar nada.
      setError(err instanceof ApiClientError ? err.message : 'No se pudo enviar el conteo');
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === 'loading') {
    return <p>Cargando...</p>;
  }

  if (phase === 'blocked') {
    return (
      <div className="page">
        <h1>Conteo físico</h1>
        <p className="error" role="alert">
          {error ?? 'Tu usuario no tiene una sucursal asignada; no se puede iniciar un conteo.'}
        </p>
        <Link to="/">Volver</Link>
      </div>
    );
  }

  if (phase === 'recounting' && result) {
    return (
      <RecountStep
        count={result}
        products={products}
        presentationsByProduct={presentationsByProduct}
        onDone={() => setPhase('done')}
      />
    );
  }

  if (phase === 'done') {
    return (
      <div className="page">
        <h1>Conteo enviado</h1>
        <p>El conteo de la semana del {weekStart} quedó registrado.</p>
        <Link to="/">Volver al inicio</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Conteo físico semanal</h1>
      <p className="muted">
        Semana del {weekStart} · Contado por {user?.displayName}. Lo que ya cargaste se guarda
        automáticamente en este dispositivo, aunque se corte la conexión o cierres la app.
      </p>

      <p className="muted count-progress" aria-live="polite">
        {countedTotal} de {products.length} productos contados.
      </p>

      {categoriesWithMissing.length > 0 && (
        <div className="card count-missing-summary" role="status">
          <strong>
            Faltan {missingProducts.length} producto{missingProducts.length === 1 ? '' : 's'} por
            contar:
          </strong>
          <ul className="count-missing-list">
            {categoriesWithMissing.map((g) => (
              <li key={g.category}>
                <button type="button" onClick={() => jumpToCategory(g.category)}>
                  {g.category} ({g.missing})
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {grouped.map((group) => (
        <CategorySection
          key={group.category}
          category={group.category}
          products={group.products}
          items={items}
          presentationsByProduct={presentationsByProduct}
          onChangeItem={updateItem}
          detailsRef={(el) => registerCategoryRef(group.category, el)}
        />
      ))}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="submit-bar">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting || missingProducts.length > 0}
          title={
            missingProducts.length > 0
              ? `Faltan ${missingProducts.length} producto(s) por contar`
              : undefined
          }
        >
          {submitting ? 'Enviando...' : 'Enviar conteo'}
        </button>
      </div>
    </div>
  );
}

/** Mirroría del lado del cliente de la validación del backend (RN-025,
 * `apps/api/src/services/inventory-count.ts`, `computeItem`): un sabor con
 * unidades abiertas necesita la fracción estimada. Evita un viaje al
 * servidor para un error que ya se puede detectar acá -- el backend sigue
 * siendo quien realmente lo exige. */
function findMissingFraction(
  products: Product[],
  submittedItems: InventoryCountDraftItem[],
): string | null {
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const item of submittedItems) {
    const product = byId.get(item.productId);
    if (!product || !isFlavorProduct(product)) continue;
    if (item.openUnits && item.openUnits > 0 && !item.openFraction) {
      return `Falta indicar la fracción estimada de lo abierto en el Salón para "${product.name}".`;
    }
  }
  return null;
}

function CategorySection({
  category,
  products,
  items,
  presentationsByProduct,
  onChangeItem,
  detailsRef,
}: {
  category: string;
  products: Product[];
  items: Record<string, InventoryCountDraftItem>;
  presentationsByProduct: Map<string, ProductCountingPresentation[]>;
  onChangeItem: (productId: string, patch: Partial<InventoryCountDraftItem>) => void;
  detailsRef?: (el: HTMLDetailsElement | null) => void;
}) {
  const counted = products.filter((p) =>
    isItemCounted(items[p.id], (presentationsByProduct.get(p.id)?.length ?? 0) > 0),
  ).length;

  return (
    <details className="card count-category" ref={detailsRef}>
      <summary className="count-category-summary">
        <strong>{category}</strong>
        <span className="muted">
          {counted}/{products.length} contados
        </span>
      </summary>
      <ul className="count-list">
        {products.map((product) => (
          <CountRow
            key={product.id}
            product={product}
            item={items[product.id]}
            presentations={presentationsByProduct.get(product.id) ?? []}
            onChange={(patch) => onChangeItem(product.id, patch)}
          />
        ))}
      </ul>
    </details>
  );
}

function CountRow({
  product,
  item,
  presentations,
  onChange,
}: {
  product: Product;
  item: InventoryCountDraftItem | undefined;
  presentations: ProductCountingPresentation[];
  onChange: (patch: Partial<InventoryCountDraftItem>) => void;
}) {
  return (
    <li className="card count-row">
      <strong>{product.name}</strong>
      <QuantityFields
        isFlavor={isFlavorProduct(product)}
        showsLoose={showsLooseField(product)}
        unitOfMeasureName={product.unitOfMeasureName}
        presentations={presentations}
        item={item}
        onChange={onChange}
      />
    </li>
  );
}

/**
 * Los campos posibles de una línea de conteo (sección 1/2 del prompt de
 * Etapa 6.2.1, mismos que la planilla de papel real): "Cerrados"/"Salón -
 * cerrada" siempre; "Sueltos"/"Salón - abierta" sólo cuando corresponde
 * (`showsLoose`); la fracción estimada sólo para un sabor con abiertos > 0;
 * y "Depósito" sólo para un sabor (3ra línea, exclusiva de sabores).
 * Compartido entre el conteo principal y el reconteo para no duplicar esta
 * lógica en dos lugares.
 *
 * Etapa 6.2.2, secciones 14-18 del prompt: cuando el producto tiene
 * presentaciones de conteo activas configuradas (`presentations` no vacío,
 * ej. Unidad/Caja/Pack -- nunca hardcodeado, se renderiza lo que el backend
 * devuelva), reemplazan por completo al campo "Cerrados" -- son mutuamente
 * excluyentes, igual que exige el backend (`computeItem`). Nunca se
 * multiplica nada acá: cada input pide la cantidad FÍSICA de esa
 * presentación tal cual está escrita en el papel (ej. "2 cajas"), y el
 * backend es quien la convierte a la cantidad canónica al recibirla.
 */
function QuantityFields({
  isFlavor,
  showsLoose,
  unitOfMeasureName,
  presentations,
  item,
  onChange,
}: {
  isFlavor: boolean;
  showsLoose: boolean;
  unitOfMeasureName: string;
  presentations: ProductCountingPresentation[];
  item: InventoryCountDraftItem | undefined;
  onChange: (patch: Partial<InventoryCountDraftItem>) => void;
}) {
  if (presentations.length > 0) {
    return <PresentationFields presentations={presentations} item={item} onChange={onChange} />;
  }

  const openUnits = item?.openUnits ?? undefined;
  const closedLabel = isFlavor
    ? `Salón - cerrada (${unitOfMeasureName})`
    : `Cerrados (${unitOfMeasureName})`;
  const openLabel = isFlavor ? 'Salón - abierta' : 'Sueltos';

  return (
    <>
      {isFlavor && (
        <p className="muted count-caption">
          Salón: lo que está en la heladera de venta. Depósito: lo guardado en la cámara propia de
          esta heladería.
        </p>
      )}
      <div className="count-fields">
        <label>
          {closedLabel}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={item?.closedUnits ?? ''}
            onChange={(event) => onChange({ closedUnits: toNumberOrUndefined(event.target.value) })}
          />
        </label>
        {showsLoose && (
          <label>
            {openLabel}
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={item?.openUnits ?? ''}
              onChange={(event) => {
                const value = toNumberOrUndefined(event.target.value);
                onChange({
                  openUnits: value,
                  openFraction: value && value > 0 ? item?.openFraction : undefined,
                });
              }}
            />
          </label>
        )}
        {isFlavor && !!openUnits && openUnits > 0 && (
          <label>
            Fracción estimada de lo abierto
            <select
              value={item?.openFraction ?? ''}
              onChange={(event) =>
                onChange({
                  openFraction: (event.target.value || undefined) as OpenContainerFraction,
                })
              }
            >
              <option value="">Elegir...</option>
              {OPEN_CONTAINER_FRACTIONS.map((fraction) => (
                <option key={fraction} value={fraction}>
                  {FRACTION_LABELS[fraction]}
                </option>
              ))}
            </select>
          </label>
        )}
        {isFlavor && (
          <label>
            Depósito ({unitOfMeasureName} cerradas)
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={item?.depositoClosedUnits ?? ''}
              onChange={(event) =>
                onChange({ depositoClosedUnits: toNumberOrUndefined(event.target.value) })
              }
            />
          </label>
        )}
      </div>
    </>
  );
}

/** Cambia (o quita, si se vacía) la cantidad de UNA presentación dentro de
 * `item.presentations` -- las demás presentaciones del mismo producto no se
 * tocan, así que se puede cargar sólo "2 cajas" sin tener que completar
 * también Pack/Unidad si no aplican a ese conteo. */
function updatePresentationQuantity(
  current: PresentationQuantityInput[] | undefined,
  presentationId: string,
  raw: string,
): PresentationQuantityInput[] {
  const quantity = toNumberOrUndefined(raw);
  const withoutThis = (current ?? []).filter((p) => p.presentationId !== presentationId);
  return quantity === undefined ? withoutThis : [...withoutThis, { presentationId, quantity }];
}

/**
 * Campos dinámicos por presentación (Etapa 6.2.2, secciones 14/15/18 del
 * prompt): un `<input>` por cada `ProductCountingPresentation` ACTIVA del
 * producto, rotulado con `unitOfMeasureName` tal cual viene del backend --
 * nunca "Unidad/Caja/Pack" hardcodeado acá. Agregar una presentación nueva
 * desde el admin (o cualquier nombre de unidad de manejo) aparece sola en
 * esta pantalla sin tocar código, igual que la agrupación por categoría de
 * Etapa 6.2.1.
 */
function PresentationFields({
  presentations,
  item,
  onChange,
}: {
  presentations: ProductCountingPresentation[];
  item: InventoryCountDraftItem | undefined;
  onChange: (patch: Partial<InventoryCountDraftItem>) => void;
}) {
  const byId = new Map((item?.presentations ?? []).map((p) => [p.presentationId, p.quantity]));
  return (
    <div className="count-fields">
      {presentations.map((presentation) => (
        <label key={presentation.id}>
          {presentation.unitOfMeasureName}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={byId.get(presentation.id) ?? ''}
            onChange={(event) =>
              onChange({
                presentations: updatePresentationQuantity(
                  item?.presentations,
                  presentation.id,
                  event.target.value,
                ),
              })
            }
          />
        </label>
      ))}
    </div>
  );
}

/**
 * Reconteo (sección 5 del prompt): sólo los productos marcados
 * `needsRecount` en la respuesta del envío original -- un único reenvío
 * adicional, no un loop. Ya no es ciego respecto del ENVÍO (el original ya
 * respondió), pero esta pantalla sigue sin mostrar teórico/diferencia --
 * tampoco hace falta para recontar. `products` se recibe del padre (ya los
 * había cargado para el conteo principal) para no repetir el fetch.
 */
function RecountStep({
  count,
  products,
  presentationsByProduct,
  onDone,
}: {
  count: InventoryCount;
  products: Product[];
  presentationsByProduct: Map<string, ProductCountingPresentation[]>;
  onDone: () => void;
}) {
  const { api } = useAuth();
  const flaggedItems = useMemo(() => count.items.filter((i) => i.needsRecount), [count]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [values, setValues] = useState<Record<string, InventoryCountDraftItem>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  function updateItem(productId: string, patch: Partial<InventoryCountDraftItem>) {
    setValues((current) => {
      const existing = current[productId] ?? { productId };
      return { ...current, [productId]: { ...existing, ...patch } };
    });
  }

  async function handleSubmit() {
    setError(null);
    const submittedItems = Object.values(values).filter((item) =>
      isItemCounted(item, (presentationsByProduct.get(item.productId)?.length ?? 0) > 0),
    );
    if (submittedItems.length !== flaggedItems.length) {
      setError('Recontá todos los productos marcados antes de enviar.');
      return;
    }
    const validationError = findMissingFraction(products, submittedItems);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/api/shop/counts/${count.id}/recount`, {
        items: submittedItems,
        idempotencyKey: idempotencyKeyRef.current,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'No se pudo enviar el reconteo');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>Reconteo</h1>
      <p className="muted">
        Algunos productos tuvieron una diferencia grande y necesitan un segundo conteo.
      </p>
      <ul className="count-list">
        {flaggedItems.map((flagged: InventoryCountItemResult) => {
          const product = productsById.get(flagged.productId);
          const isFlavor = product ? isFlavorProduct(product) : false;
          const showsLoose = product ? showsLooseField(product) : true;
          const item = values[flagged.productId];
          return (
            <li className="card count-row" key={flagged.productId}>
              <strong>{flagged.productName}</strong>
              <QuantityFields
                isFlavor={isFlavor}
                showsLoose={showsLoose}
                unitOfMeasureName={product?.unitOfMeasureName ?? ''}
                presentations={presentationsByProduct.get(flagged.productId) ?? []}
                item={item}
                onChange={(patch) => updateItem(flagged.productId, patch)}
              />
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="submit-bar">
        <button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? 'Enviando...' : 'Enviar reconteo'}
        </button>
      </div>
    </div>
  );
}
