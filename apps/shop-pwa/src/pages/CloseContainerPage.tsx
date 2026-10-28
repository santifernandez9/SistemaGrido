import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type { Product } from '@sistema-grido/shared-types';
import { newIdempotencyKey } from '../lib/id.js';

/**
 * Baja normal de lata (RF-021/RN-027): un único toque, sin motivo, siempre
 * UNA unidad de manejo completa -- "si tarda más que anotarlo en la
 * planilla, el diseño está mal" (sección 7 del prompt de Etapa 4).
 */
export function CloseContainerPage() {
  const { user, api } = useAuth();
  const locationId = user?.defaultLocationId ?? null;
  const [flavors, setFlavors] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .get<Product[]>('/api/products')
      .then((products) => {
        const list = products.filter((p) => p.active && p.flavorId !== null);
        setFlavors(list);
        setProductId((current) => current || (list[0]?.id ?? ''));
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : 'No se pudo cargar'))
      .finally(() => setLoading(false));
  }, [api]);

  async function handleConfirm() {
    if (!locationId || !productId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/shop/ice-cream-containers/close', {
        locationId,
        productId,
        idempotencyKey: newIdempotencyKey(),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'No se pudo registrar la baja');
    } finally {
      setSubmitting(false);
    }
  }

  if (!locationId) {
    return (
      <div className="page">
        <h1>Baja de lata</h1>
        <p className="error" role="alert">
          Tu usuario no tiene una sucursal asignada.
        </p>
        <Link to="/">Volver</Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="page">
        <h1>Lata dada de baja</h1>
        <p>Se registró correctamente.</p>
        <div className="submit-bar">
          <button type="button" onClick={() => setDone(false)}>
            Dar de baja otra
          </button>
        </div>
        <Link to="/">Volver al inicio</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Baja de lata</h1>
      <p className="muted">
        Elegí el sabor y confirmá -- no hace falta indicar cantidad ni motivo.
      </p>
      {loading && <p>Cargando...</p>}
      {!loading && (
        <>
          <label htmlFor="flavor-select">Sabor</label>
          <select
            id="flavor-select"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {flavors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
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
              {submitting ? 'Guardando...' : 'Confirmar baja'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
