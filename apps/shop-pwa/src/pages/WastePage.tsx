import { useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import {
  DECIMAL_QUANTITY_PATTERN,
  OPEN_CONTAINER_FRACTIONS,
  type OpenContainerFraction,
  type Product,
} from '@sistema-grido/shared-types';
import { newIdempotencyKey } from '../lib/id.js';
import { uploadAttachment } from '../lib/uploadAttachment.js';

const FRACTION_LABELS: Record<OpenContainerFraction, string> = {
  FULL: 'Llena',
  THREE_QUARTERS: '3/4',
  HALF: '1/2',
  QUARTER: '1/4',
  NEARLY_EMPTY: 'Casi vacía',
};

type QuantityMode = 'exact' | 'fraction';

/**
 * Merma con foto (RF-024/025/RN-029..032). La foto es obligatoria; se sube
 * directo a Supabase Storage antes de crear la merma (ver
 * `../lib/uploadAttachment.ts`) -- nunca como base64 en el body.
 */
export function WastePage() {
  const { user, api } = useAuth();
  const locationId = user?.defaultLocationId ?? null;

  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [mode, setMode] = useState<QuantityMode>('exact');
  const [enteredQuantity, setEnteredQuantity] = useState('1');
  const [fraction, setFraction] = useState<OpenContainerFraction>('HALF');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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

  const selectedProduct = products.find((p) => p.id === productId) ?? null;
  const isFlavor = selectedProduct?.flavorId !== null && selectedProduct !== null;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  async function handleSubmit() {
    setError(null);
    if (!locationId || !productId) return;
    if (!reason.trim()) {
      setError('Indicá el motivo de la merma.');
      return;
    }
    if (!file) {
      setError('Sacá o elegí una foto de la merma.');
      return;
    }
    if (mode === 'exact' && !DECIMAL_QUANTITY_PATTERN.test(enteredQuantity)) {
      setError('Cantidad inválida.');
      return;
    }

    setSubmitting(true);
    try {
      const photoPath = await uploadAttachment(api, 'WASTE_PHOTO', file);
      await api.post('/api/shop/waste', {
        locationId,
        productId,
        reason: reason.trim(),
        photoPath,
        idempotencyKey: newIdempotencyKey(),
        ...(mode === 'exact' ? { enteredQuantity } : { fraction }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'No se pudo registrar la merma');
    } finally {
      setSubmitting(false);
    }
  }

  if (!locationId) {
    return (
      <div className="page">
        <h1>Merma</h1>
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
        <h1>Merma registrada</h1>
        <Link to="/">Volver al inicio</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Merma</h1>
      {loading && <p>Cargando...</p>}
      {!loading && (
        <>
          <label htmlFor="waste-product">Producto</label>
          <select
            id="waste-product"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <fieldset className="mode-fieldset">
            <label>
              <input
                type="radio"
                name="waste-mode"
                checked={mode === 'exact'}
                onChange={() => setMode('exact')}
              />
              Cantidad exacta
            </label>
            {isFlavor && (
              <label>
                <input
                  type="radio"
                  name="waste-mode"
                  checked={mode === 'fraction'}
                  onChange={() => setMode('fraction')}
                />
                Fracción de lata abierta
              </label>
            )}
          </fieldset>

          {mode === 'exact' ? (
            <>
              <label htmlFor="waste-quantity">Cantidad</label>
              <input
                id="waste-quantity"
                type="text"
                inputMode="decimal"
                value={enteredQuantity}
                onChange={(e) => setEnteredQuantity(e.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor="waste-fraction">Fracción</label>
              <select
                id="waste-fraction"
                value={fraction}
                onChange={(e) => setFraction(e.target.value as OpenContainerFraction)}
              >
                {OPEN_CONTAINER_FRACTIONS.map((f) => (
                  <option key={f} value={f}>
                    {FRACTION_LABELS[f]}
                  </option>
                ))}
              </select>
            </>
          )}

          <label htmlFor="waste-reason">Motivo</label>
          <input
            id="waste-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej: se cayó, vencido, etc."
          />

          <label htmlFor="waste-photo">Foto</label>
          <input
            id="waste-photo"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
          />

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <div className="submit-bar">
            <button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? 'Guardando...' : 'Registrar merma'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
