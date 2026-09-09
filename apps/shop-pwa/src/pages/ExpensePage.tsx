import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import { MONEY_AMOUNT_PATTERN } from '@sistema-grido/shared-types';
import { newIdempotencyKey } from '../lib/id.js';
import { uploadAttachment } from '../lib/uploadAttachment.js';

/**
 * Gasto variable (RF-026/RN-033). No es parte del ledger de inventario --
 * entidad propia, sin impacto en stock (sección 9 del prompt de Etapa 4). El
 * comprobante es opcional.
 */
export function ExpensePage() {
  const { user, api } = useAuth();
  const locationId = user?.defaultLocationId ?? null;

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  async function handleSubmit() {
    setError(null);
    if (!locationId) return;
    if (!MONEY_AMOUNT_PATTERN.test(amount)) {
      setError('Monto inválido: escribí un número con hasta 2 decimales, ej. "1500.50".');
      return;
    }
    if (!category.trim()) {
      setError('Indicá una categoría.');
      return;
    }
    if (!description.trim()) {
      setError('Indicá una descripción.');
      return;
    }

    setSubmitting(true);
    try {
      const receiptPath = file ? await uploadAttachment(api, 'EXPENSE_RECEIPT', file) : undefined;
      await api.post('/api/shop/expenses', {
        locationId,
        amount,
        category: category.trim(),
        description: description.trim(),
        receiptPath,
        idempotencyKey: newIdempotencyKey(),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'No se pudo registrar el gasto');
    } finally {
      setSubmitting(false);
    }
  }

  if (!locationId) {
    return (
      <div className="page">
        <h1>Gasto</h1>
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
        <h1>Gasto registrado</h1>
        <Link to="/">Volver al inicio</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Gasto variable</h1>

      <label htmlFor="expense-amount">Monto</label>
      <input
        id="expense-amount"
        type="text"
        inputMode="decimal"
        placeholder="Ej: 1500.50"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <label htmlFor="expense-category">Categoría</label>
      <input
        id="expense-category"
        type="text"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="Ej: limpieza, insumos, servicios"
      />

      <label htmlFor="expense-description">Descripción</label>
      <input
        id="expense-description"
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <label htmlFor="expense-receipt">Comprobante (opcional)</label>
      <input
        id="expense-receipt"
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
          {submitting ? 'Guardando...' : 'Registrar gasto'}
        </button>
      </div>
    </div>
  );
}
