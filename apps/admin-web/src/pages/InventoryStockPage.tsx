import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import {
  DECIMAL_QUANTITY_PATTERN,
  type CreateAdjustmentInput,
  type CreateInitialStockInput,
  type LocationSummary,
  type Product,
  type StockBalance,
} from '@sistema-grido/shared-types';

const EMPTY_INITIAL: CreateInitialStockInput = {
  locationId: '',
  productId: '',
  enteredQuantity: '1',
};

const EMPTY_ADJUSTMENT: CreateAdjustmentInput = {
  locationId: '',
  productId: '',
  enteredQuantity: '1',
  reason: '',
};

/**
 * Motor de inventario (Etapa 3) — stock teórico por ubicación/producto,
 * siempre calculado desde el ledger (nunca un campo editable, ver
 * docs/ETAPA-3-MOTOR-INVENTARIO.md). Un saldo negativo se muestra, no se
 * oculta ni se corrige solo -- es una señal a investigar (decisión
 * confirmada explícitamente para esta etapa).
 *
 * Etapa 3.1, corrección del Problema 2: las cantidades ingresadas viajan
 * como STRING decimal (`CreateInitialStockInput.enteredQuantity`,
 * `CreateAdjustmentInput.enteredQuantity`), nunca como `number` de JS. Por
 * eso los campos de cantidad son `<input type="text" inputMode="decimal">`
 * con el valor guardado tal cual lo tipeó la persona -- nunca
 * `valueAsNumber` ni `Number(...)` en ningún punto de este archivo. El
 * formato se valida contra `DECIMAL_QUANTITY_PATTERN` (mismo patrón que usa
 * el backend) antes de enviar, mostrando un error comprensible si no matchea.
 */
export function InventoryStockPage() {
  const { api } = useAuth();
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locationFilter, setLocationFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');

  const [initialForm, setInitialForm] = useState<CreateInitialStockInput>(EMPTY_INITIAL);
  const [initialSubmitting, setInitialSubmitting] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [initialOk, setInitialOk] = useState<string | null>(null);

  const [adjustmentForm, setAdjustmentForm] = useState<CreateAdjustmentInput>(EMPTY_ADJUSTMENT);
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false);
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const [adjustmentOk, setAdjustmentOk] = useState<string | null>(null);

  const loadMasters = useCallback(async () => {
    const [locationsData, productsData] = await Promise.all([
      api.get<LocationSummary[]>('/api/locations'),
      api.get<Product[]>('/api/products'),
    ]);
    setLocations(locationsData);
    setProducts(productsData);
    setInitialForm((s) => ({
      ...s,
      locationId: s.locationId || (locationsData[0]?.id ?? ''),
      productId: s.productId || (productsData[0]?.id ?? ''),
    }));
    setAdjustmentForm((s) => ({
      ...s,
      locationId: s.locationId || (locationsData[0]?.id ?? ''),
      productId: s.productId || (productsData[0]?.id ?? ''),
    }));
  }, [api]);

  const loadBalances = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set('locationId', locationFilter);
      if (productFilter) params.set('productId', productFilter);
      const query = params.toString();
      setBalances(await api.get<StockBalance[]>(`/api/inventory/stock${query ? `?${query}` : ''}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el stock');
    } finally {
      setLoading(false);
    }
  }, [api, locationFilter, productFilter]);

  // Sin eslint-disable: `loadMasters`/`loadBalances` son estables mientras
  // sus propias dependencias (api, locationFilter, productFilter) no
  // cambien -- useCallback hace que el efecto se re-ejecute exactamente
  // cuando corresponde, sin necesitar la excepción del linter (Etapa 3.1,
  // corrección del Problema 4).
  useEffect(() => {
    void loadMasters();
  }, [loadMasters]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  async function handleInitialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInitialError(null);
    setInitialOk(null);
    if (!DECIMAL_QUANTITY_PATTERN.test(initialForm.enteredQuantity)) {
      setInitialError(
        'Cantidad inválida: escribí un número decimal con hasta 3 decimales, ej. "12.375".',
      );
      return;
    }
    setInitialSubmitting(true);
    try {
      await api.post('/api/inventory/stock/initial', initialForm);
      setInitialOk('Stock inicial cargado.');
      await loadBalances();
    } catch (err) {
      setInitialError(
        err instanceof ApiClientError ? err.message : 'No se pudo cargar el stock inicial',
      );
    } finally {
      setInitialSubmitting(false);
    }
  }

  async function handleAdjustmentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdjustmentError(null);
    setAdjustmentOk(null);
    if (!DECIMAL_QUANTITY_PATTERN.test(adjustmentForm.enteredQuantity)) {
      setAdjustmentError(
        'Cantidad inválida: escribí un número decimal (opcionalmente negativo) con hasta 3 decimales, ej. "-5.5".',
      );
      return;
    }
    setAdjustmentSubmitting(true);
    try {
      await api.post('/api/inventory/adjustments', adjustmentForm);
      setAdjustmentOk('Ajuste registrado.');
      setAdjustmentForm((s) => ({ ...s, enteredQuantity: '1', reason: '' }));
      await loadBalances();
    } catch (err) {
      setAdjustmentError(
        err instanceof ApiClientError ? err.message : 'No se pudo registrar el ajuste',
      );
    } finally {
      setAdjustmentSubmitting(false);
    }
  }

  return (
    <div className="catalog-page">
      <h1>Stock</h1>
      <p className="muted">
        Stock teórico por ubicación y producto, calculado siempre a partir del ledger de movimientos
        -- nunca un valor editable directamente.
      </p>

      <section className="card">
        <h2>Cargar stock inicial</h2>
        <p className="muted">
          Punto de partida del ledger para un producto en una ubicación. Sólo se puede cargar una
          vez por producto/ubicación -- si ya existe, revertí el movimiento existente desde
          "Movimientos" antes de cargar uno nuevo.
        </p>
        <form onSubmit={(event) => void handleInitialSubmit(event)} className="inline-form">
          <label htmlFor="init-location">Ubicación</label>
          <select
            id="init-location"
            required
            value={initialForm.locationId}
            onChange={(event) => setInitialForm((s) => ({ ...s, locationId: event.target.value }))}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>

          <label htmlFor="init-product">Producto</label>
          <select
            id="init-product"
            required
            value={initialForm.productId}
            onChange={(event) => setInitialForm((s) => ({ ...s, productId: event.target.value }))}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.unitOfMeasureName})
              </option>
            ))}
          </select>

          <label htmlFor="init-quantity">
            Cantidad (
            {productById.get(initialForm.productId)?.unitOfMeasureName ?? 'unidad de manejo'}) --
            hasta 3 decimales
          </label>
          <input
            id="init-quantity"
            type="text"
            inputMode="decimal"
            placeholder="Ej: 12.375"
            required
            value={initialForm.enteredQuantity}
            onChange={(event) =>
              setInitialForm((s) => ({ ...s, enteredQuantity: event.target.value }))
            }
          />

          {initialError && (
            <p className="error" role="alert">
              {initialError}
            </p>
          )}
          {initialOk && <p role="status">{initialOk}</p>}

          <div className="form-actions">
            <button type="submit" disabled={initialSubmitting}>
              {initialSubmitting ? 'Guardando...' : 'Cargar stock inicial'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Registrar ajuste</h2>
        <p className="muted">
          Corrección manual con motivo obligatorio. Puede ser positivo o negativo -- un ajuste que
          deje el saldo en negativo se acepta igual, queda visible como una diferencia a revisar.
        </p>
        <form onSubmit={(event) => void handleAdjustmentSubmit(event)} className="inline-form">
          <label htmlFor="adj-location">Ubicación</label>
          <select
            id="adj-location"
            required
            value={adjustmentForm.locationId}
            onChange={(event) =>
              setAdjustmentForm((s) => ({ ...s, locationId: event.target.value }))
            }
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>

          <label htmlFor="adj-product">Producto</label>
          <select
            id="adj-product"
            required
            value={adjustmentForm.productId}
            onChange={(event) =>
              setAdjustmentForm((s) => ({ ...s, productId: event.target.value }))
            }
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.unitOfMeasureName})
              </option>
            ))}
          </select>

          <label htmlFor="adj-quantity">
            Cantidad (con signo; negativa resta) (
            {productById.get(adjustmentForm.productId)?.unitOfMeasureName ?? 'unidad de manejo'}) --
            hasta 3 decimales
          </label>
          <input
            id="adj-quantity"
            type="text"
            inputMode="decimal"
            placeholder="Ej: -5.5"
            required
            value={adjustmentForm.enteredQuantity}
            onChange={(event) =>
              setAdjustmentForm((s) => ({ ...s, enteredQuantity: event.target.value }))
            }
          />

          <label htmlFor="adj-reason">Motivo</label>
          <input
            id="adj-reason"
            type="text"
            required
            value={adjustmentForm.reason}
            onChange={(event) => setAdjustmentForm((s) => ({ ...s, reason: event.target.value }))}
          />

          {adjustmentError && (
            <p className="error" role="alert">
              {adjustmentError}
            </p>
          )}
          {adjustmentOk && <p role="status">{adjustmentOk}</p>}

          <div className="form-actions">
            <button type="submit" disabled={adjustmentSubmitting}>
              {adjustmentSubmitting ? 'Guardando...' : 'Registrar ajuste'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="list-toolbar">
          <h2>Stock por ubicación / producto</h2>
        </div>
        <div className="filters">
          <label>
            Ubicación
            <select
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Producto
            <select
              value={productFilter}
              onChange={(event) => setProductFilter(event.target.value)}
            >
              <option value="">Todos</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loading && <p>Cargando...</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && balances.length === 0 && (
          <p className="empty-state">No hay stock cargado todavía para este filtro.</p>
        )}
        {!loading && !error && balances.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Ubicación</th>
                <th>Producto</th>
                <th>Código</th>
                <th>Cantidad</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => {
                const negative = Number(b.quantity) < 0;
                return (
                  <tr key={`${b.locationId}-${b.productId}`}>
                    <td>{b.locationName}</td>
                    <td>{b.productName}</td>
                    <td>{b.productCode ?? '—'}</td>
                    <td className={negative ? 'negative-quantity' : undefined}>
                      {formatQuantity(b.quantity)}
                      {negative && (
                        <span className="badge badge-warn" style={{ marginLeft: 8 }}>
                          Negativo
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** Recorta ceros finales del NUMERIC(14,3) que devuelve la API sólo para mostrarlo
 * más legible -- el valor exacto sigue viajando sin redondear en `quantity`. Esto
 * es sólo DISPLAY (una conversión a `number` de un valor ya persistido, para
 * formatear con separadores de miles); nunca se usa para calcular ni para
 * volver a enviar una cantidad al backend -- ver el comentario de Problema 2
 * arriba. */
function formatQuantity(quantity: string): string {
  const n = Number(quantity);
  return Number.isFinite(n) ? n.toLocaleString('es-AR', { maximumFractionDigits: 3 }) : quantity;
}
