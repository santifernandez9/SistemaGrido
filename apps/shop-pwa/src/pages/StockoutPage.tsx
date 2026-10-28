import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type { Product, StockoutEvent } from '@sistema-grido/shared-types';
import { newIdempotencyKey } from '../lib/id.js';

const CLASSIFICATION_LABELS: Record<string, string> = {
  URGENT_RESTOCK: 'Reposición urgente posible',
  SUPPLY_SHORTAGE: 'Faltante de abastecimiento',
};

/**
 * "Sin stock" (RF-019/RN-019): sólo una incidencia -- nunca modifica stock,
 * nunca bloquea por saldo negativo (sección 10 del prompt de Etapa 4).
 */
export function StockoutPage() {
  const { user, api } = useAuth();
  const locationId = user?.defaultLocationId ?? null;

  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StockoutEvent | null>(null);

  useEffect(() => {
    api
      .get<Product[]>('/api/products')
      .then((list) => {
        const active = list.filter((p) => p.active);
        setProducts(active);
        setProductId((current) => current || (active[0]?.id ?? ''));
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : 'No se pudo cargar'))
      .finally(() => setLoading(false));
  }, [api]);

  async function handleConfirm() {
    if (!locationId || !productId) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post<StockoutEvent>('/api/shop/stockouts', {
        locationId,
        productId,
        idempotencyKey: newIdempotencyKey(),
      });
      setResult(created);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'No se pudo registrar el evento');
    } finally {
      setSubmitting(false);
    }
  }

  if (!locationId) {
    return (
      <div className="page">
        <h1>Sin stock</h1>
        <p className="error" role="alert">
          Tu usuario no tiene una sucursal asignada.
        </p>
        <Link to="/">Volver</Link>
      </div>
    );
  }

  if (result) {
    return (
      <div className="page">
        <h1>Marcado sin stock</h1>
        <p>{result.productName}</p>
        {result.classification && (
          <p className="location-badge">{CLASSIFICATION_LABELS[result.classification]}</p>
        )}
        <div className="submit-bar">
          <button type="button" onClick={() => setResult(null)}>
            Marcar otro
          </button>
        </div>
        <Link to="/">Volver al inicio</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Sin stock</h1>
      <p className="muted">Marcá un producto como agotado -- no modifica el stock, sólo avisa.</p>
      {loading && <p>Cargando...</p>}
      {!loading && (
        <>
          <label htmlFor="stockout-product">Producto</label>
          <select
            id="stockout-product"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <div className="submit-bar">
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={submitting || !productId}
            >
              {submitting ? 'Guardando...' : 'Marcar sin stock'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
