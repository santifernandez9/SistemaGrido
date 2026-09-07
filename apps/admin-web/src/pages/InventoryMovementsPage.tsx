import { useEffect, useMemo, useState } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import {
  MOVEMENT_TYPES,
  type InventoryMovement,
  type LocationSummary,
  type MovementType,
  type Page,
  type Product,
} from '@sistema-grido/shared-types';

const PAGE_SIZE = 20;

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  INITIAL_STOCK: 'Stock inicial',
  PURCHASE_RECEIPT: 'Ingreso de compra',
  TRANSFER_OUT: 'Salida por transferencia',
  TRANSFER_IN: 'Entrada por transferencia',
  SALE: 'Venta',
  BOM_CONSUMPTION: 'Consumo de receta',
  WASTE: 'Merma',
  ICE_CREAM_CONTAINER_CLOSE: 'Baja de lata',
  ADJUSTMENT: 'Ajuste',
  EXTERNAL_OUT: 'Salida externa',
  COUNT_CORRECTION: 'Corrección de conteo',
};

/**
 * Historial de movimientos (Etapa 3, sección 22 del prompt: filtrable y
 * paginado, nunca todo el ledger de una vez). El detalle se muestra con los
 * datos que ya trae la fila -- la API ya expone el DTO completo en el
 * listado (`GET /api/inventory/movements`), así que no hace falta un segundo
 * pedido a `GET /api/inventory/movements/:id` sólo para mostrarlo (ese
 * endpoint sigue existiendo y se prueba a nivel de API para acceso directo
 * por id/enlace).
 */
export function InventoryMovementsPage() {
  const { api } = useAuth();
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage] = useState<Page<InventoryMovement> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locationFilter, setLocationFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<MovementType | ''>('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [pageNumber, setPageNumber] = useState(1);

  const [selected, setSelected] = useState<InventoryMovement | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseSubmitting, setReverseSubmitting] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);

  async function loadMasters() {
    const [locationsData, productsData] = await Promise.all([
      api.get<LocationSummary[]>('/api/locations'),
      api.get<Product[]>('/api/products'),
    ]);
    setLocations(locationsData);
    setProducts(productsData);
  }

  async function loadMovements() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set('locationId', locationFilter);
      if (productFilter) params.set('productId', productFilter);
      if (typeFilter) params.set('movementType', typeFilter);
      if (fromFilter) params.set('occurredFrom', fromFilter);
      if (toFilter) params.set('occurredTo', toFilter);
      params.set('page', String(pageNumber));
      params.set('pageSize', String(PAGE_SIZE));
      const result = await api.get<Page<InventoryMovement>>(`/api/inventory/movements?${params}`);
      setPage(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el historial');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMasters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadMovements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationFilter, productFilter, typeFilter, fromFilter, toFilter, pageNumber]);

  // Cualquier cambio de filtro vuelve a la página 1 (evita quedar en una página vacía).
  useEffect(() => {
    setPageNumber(1);
  }, [locationFilter, productFilter, typeFilter, fromFilter, toFilter]);

  const totalPages = useMemo(() => {
    if (!page || page.total === 0) return 1;
    return Math.ceil(page.total / page.pageSize);
  }, [page]);

  function openDetail(movement: InventoryMovement) {
    setSelected(movement);
    setReverseReason('');
    setReverseError(null);
  }

  async function handleReverse() {
    if (!selected) return;
    setReverseSubmitting(true);
    setReverseError(null);
    try {
      await api.post(`/api/inventory/movements/${selected.id}/reverse`, { reason: reverseReason });
      setSelected(null);
      await loadMovements();
    } catch (err) {
      setReverseError(
        err instanceof ApiClientError ? err.message : 'No se pudo revertir el movimiento',
      );
    } finally {
      setReverseSubmitting(false);
    }
  }

  return (
    <div className="catalog-page">
      <h1>Movimientos</h1>
      <p className="muted">
        Historial completo del ledger: todo lo que produjo el stock actual, quién lo generó y
        cuándo.
      </p>

      <section className="card">
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
          <label>
            Tipo
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as MovementType | '')}
            >
              <option value="">Todos</option>
              {MOVEMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {MOVEMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Desde
            <input
              type="date"
              value={fromFilter}
              onChange={(event) => setFromFilter(event.target.value)}
            />
          </label>
          <label>
            Hasta
            <input
              type="date"
              value={toFilter}
              onChange={(event) => setToFilter(event.target.value)}
            />
          </label>
        </div>

        {loading && <p>Cargando...</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && page && page.items.length === 0 && (
          <p className="empty-state">No hay movimientos para este filtro.</p>
        )}
        {!loading && !error && page && page.items.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Ubicación</th>
                  <th>Producto</th>
                  <th>Tipo</th>
                  <th>Cantidad</th>
                  <th>Usuario</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((m) => (
                  <tr key={m.id} className="movement-row" onClick={() => openDetail(m)}>
                    <td>{formatDate(m.occurredAt)}</td>
                    <td>{m.locationName}</td>
                    <td>{m.productName}</td>
                    <td>{MOVEMENT_TYPE_LABELS[m.movementType]}</td>
                    <td className={Number(m.quantity) < 0 ? 'negative-quantity' : undefined}>
                      {formatQuantity(m.quantity)}
                    </td>
                    <td>{m.createdByName}</td>
                    <td>
                      <span className={`badge ${m.status === 'ACTIVE' ? 'badge-ok' : 'badge-off'}`}>
                        {m.status === 'ACTIVE' ? 'Activo' : 'Revertido'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pagination">
              <button
                type="button"
                className="secondary"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              >
                Anterior
              </button>
              <span>
                Página {page.page} de {totalPages} ({page.total} movimientos)
              </span>
              <button
                type="button"
                className="secondary"
                disabled={pageNumber >= totalPages}
                onClick={() => setPageNumber((p) => Math.min(totalPages, p + 1))}
              >
                Siguiente
              </button>
            </div>
          </>
        )}

        {selected && (
          <div className="detail-panel">
            <h2>Detalle del movimiento</h2>
            <dl className="detail-grid">
              <div>
                <dt>Producto</dt>
                <dd>
                  {selected.productName} {selected.productCode ? `(${selected.productCode})` : ''}
                </dd>
              </div>
              <div>
                <dt>Ubicación</dt>
                <dd>{selected.locationName}</dd>
              </div>
              <div>
                <dt>Tipo</dt>
                <dd>{MOVEMENT_TYPE_LABELS[selected.movementType]}</dd>
              </div>
              <div>
                <dt>Cantidad (unidad canónica)</dt>
                <dd className={Number(selected.quantity) < 0 ? 'negative-quantity' : undefined}>
                  {formatQuantity(selected.quantity)}
                </dd>
              </div>
              <div>
                <dt>Cantidad ingresada</dt>
                <dd>
                  {formatQuantity(selected.enteredQuantity)} {selected.entryUnitOfMeasureName}{' '}
                  (factor {selected.conversionFactor})
                </dd>
              </div>
              <div>
                <dt>Fecha efectiva</dt>
                <dd>{formatDate(selected.occurredAt)}</dd>
              </div>
              <div>
                <dt>Registrado</dt>
                <dd>{formatDate(selected.createdAt)}</dd>
              </div>
              <div>
                <dt>Usuario</dt>
                <dd>{selected.createdByName}</dd>
              </div>
              <div>
                <dt>Motivo</dt>
                <dd>{selected.reason ?? '—'}</dd>
              </div>
              <div>
                <dt>Estado</dt>
                <dd>{selected.status === 'ACTIVE' ? 'Activo' : 'Revertido'}</dd>
              </div>
              {selected.reversesMovementId && (
                <div>
                  <dt>Reversión del movimiento</dt>
                  <dd className="mono">{selected.reversesMovementId}</dd>
                </div>
              )}
              <div>
                <dt>Id (técnico)</dt>
                <dd className="mono">{selected.id}</dd>
              </div>
            </dl>

            {selected.status === 'ACTIVE' ? (
              <div className="inline-form">
                <label htmlFor="reverse-reason">Motivo de la reversión</label>
                <input
                  id="reverse-reason"
                  type="text"
                  value={reverseReason}
                  onChange={(event) => setReverseReason(event.target.value)}
                />
                {reverseError && (
                  <p className="error" role="alert">
                    {reverseError}
                  </p>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    disabled={reverseSubmitting || !reverseReason.trim()}
                    onClick={() => void handleReverse()}
                  >
                    {reverseSubmitting ? 'Revirtiendo...' : 'Revertir movimiento'}
                  </button>
                  <button type="button" className="secondary" onClick={() => setSelected(null)}>
                    Cerrar
                  </button>
                </div>
              </div>
            ) : (
              <div className="form-actions">
                <button type="button" className="secondary" onClick={() => setSelected(null)}>
                  Cerrar
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function formatQuantity(quantity: string): string {
  const n = Number(quantity);
  return Number.isFinite(n) ? n.toLocaleString('es-AR', { maximumFractionDigits: 3 }) : quantity;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-AR');
}
