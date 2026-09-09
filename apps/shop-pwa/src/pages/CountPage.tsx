import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import {
  OPEN_CONTAINER_FRACTIONS,
  type InventoryCount,
  type InventoryCountDraftItem,
  type OpenContainerFraction,
  type Product,
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

/**
 * Conteo físico semanal (RF-012/RF-020), CIEGO (RN-012): en ningún momento
 * mientras se cuenta se pide ni se muestra el stock teórico -- esta pantalla
 * nunca llama a `/api/inventory/stock`. El borrador vive en IndexedDB
 * (`../lib/countDraftStore.ts`, RN-013: "sobrevivir a un corte de conexión,
 * recarga accidental o cierre de la app") y sólo se borra después de que el
 * backend confirma el envío -- ver docs/ETAPA-4-APP-HELADERIA.md,
 * "Autoguardado".
 */
export function CountPage() {
  const { user, api } = useAuth();
  const locationId = user?.defaultLocationId ?? null;
  const weekStart = useMemo(() => currentWeekStartISO(), []);
  const draftId = locationId ? countDraftId(locationId, weekStart) : null;

  const [phase, setPhase] = useState<Phase>('loading');
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<Record<string, InventoryCountDraftItem>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InventoryCount | null>(null);

  const idempotencyKeyRef = useRef<string>('');
  const loadedRef = useRef(false);

  // Carga inicial: catálogo + borrador ya guardado (si lo hay) -- restaura la
  // sesión de conteo tal como quedó, sin perder nada de lo ya tipeado.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!locationId || !draftId) {
        setPhase('blocked');
        return;
      }
      try {
        const [productList, draft] = await Promise.all([
          api.get<Product[]>('/api/products'),
          loadCountDraft(draftId),
        ]);
        if (cancelled) return;
        setProducts(productList.filter((p) => p.active));
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

  function toNumberOrUndefined(raw: string): number | undefined {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  async function handleSubmit() {
    setError(null);
    const submittedItems = Object.values(items).filter(
      (item) => item.closedUnits !== undefined || item.openUnits !== undefined,
    );
    if (submittedItems.length === 0) {
      setError('Contá al menos un producto antes de enviar.');
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
    return <RecountStep count={result} onDone={() => setPhase('done')} />;
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
        Semana del {weekStart}. Contá cada producto una sola vez -- lo que ya cargaste se guarda
        automáticamente en este dispositivo, aunque se corte la conexión o cierres la app.
      </p>

      <ul className="count-list">
        {products.map((product) => (
          <CountRow
            key={product.id}
            product={product}
            item={items[product.id]}
            onChange={(patch) => updateItem(product.id, patch)}
            toNumberOrUndefined={toNumberOrUndefined}
          />
        ))}
      </ul>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="submit-bar">
        <button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? 'Enviando...' : 'Enviar conteo'}
        </button>
      </div>
    </div>
  );
}

function CountRow({
  product,
  item,
  onChange,
  toNumberOrUndefined,
}: {
  product: Product;
  item: InventoryCountDraftItem | undefined;
  onChange: (patch: Partial<InventoryCountDraftItem>) => void;
  toNumberOrUndefined: (raw: string) => number | undefined;
}) {
  const isFlavor = product.flavorId !== null;
  const openUnits = item?.openUnits ?? undefined;

  return (
    <li className="card count-row">
      <strong>{product.name}</strong>
      <span className="muted">{product.unitOfMeasureName}</span>
      <div className="count-fields">
        <label>
          Cerrados ({product.unitOfMeasureName})
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={item?.closedUnits ?? ''}
            onChange={(event) => onChange({ closedUnits: toNumberOrUndefined(event.target.value) })}
          />
        </label>
        <label>
          Sueltos / abiertos
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
      </div>
    </li>
  );
}

/**
 * Reconteo (sección 5 del prompt): sólo los productos marcados
 * `needsRecount` en la respuesta del envío original -- un único reenvío
 * adicional, no un loop. Ya no es ciego (el envío original ya respondió),
 * pero tampoco hace falta mostrar la diferencia acá: sólo se re-cuenta.
 */
function RecountStep({ count, onDone }: { count: InventoryCount; onDone: () => void }) {
  const { api } = useAuth();
  const flaggedItems = useMemo(() => count.items.filter((i) => i.needsRecount), [count]);
  const [values, setValues] = useState<Record<string, InventoryCountDraftItem>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flavorProductIds, setFlavorProductIds] = useState<Set<string>>(new Set());
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  // Necesita saber cuáles de los productos marcados son sabores (la fracción
  // estimada sólo aplica a esos, RN-025) -- `InventoryCountItemResult` no
  // incluye `flavorId`, así que se resuelve leyendo el catálogo una vez.
  useEffect(() => {
    let cancelled = false;
    void api.get<Product[]>('/api/products').then((products) => {
      if (cancelled) return;
      setFlavorProductIds(new Set(products.filter((p) => p.flavorId !== null).map((p) => p.id)));
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function toNumberOrUndefined(raw: string): number | undefined {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  function updateItem(productId: string, patch: Partial<InventoryCountDraftItem>) {
    setValues((current) => {
      const existing = current[productId] ?? { productId };
      return { ...current, [productId]: { ...existing, ...patch } };
    });
  }

  async function handleSubmit() {
    setError(null);
    const submittedItems = Object.values(values).filter(
      (item) => item.closedUnits !== undefined || item.openUnits !== undefined,
    );
    if (submittedItems.length !== flaggedItems.length) {
      setError('Recontá todos los productos marcados antes de enviar.');
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
        {flaggedItems.map((flagged) => {
          const isFlavor = flavorProductIds.has(flagged.productId);
          const item = values[flagged.productId];
          return (
            <li className="card count-row" key={flagged.productId}>
              <strong>{flagged.productName}</strong>
              <div className="count-fields">
                <label>
                  Cerrados
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={item?.closedUnits ?? ''}
                    onChange={(event) =>
                      updateItem(flagged.productId, {
                        closedUnits: toNumberOrUndefined(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Sueltos / abiertos
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={item?.openUnits ?? ''}
                    onChange={(event) =>
                      updateItem(flagged.productId, {
                        openUnits: toNumberOrUndefined(event.target.value),
                      })
                    }
                  />
                </label>
                {isFlavor && !!item?.openUnits && item.openUnits > 0 && (
                  <label>
                    Fracción estimada
                    <select
                      value={item?.openFraction ?? ''}
                      onChange={(event) =>
                        updateItem(flagged.productId, {
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
              </div>
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
