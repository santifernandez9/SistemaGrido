import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type {
  LocationSummary,
  Page,
  WeeklyClosing,
  WeeklyClosingDetail,
} from '@sistema-grido/shared-types';

/**
 * "Cierre semanal" (Etapa 6, sección 19 del prompt) -- pantalla mínima
 * obligatoria: elegir sucursal, elegir/ver semana, ver estado, ver
 * checklist, ver resumen de conteo, ver teórico vs real, ver diferencias,
 * ver ventas importadas, ver mermas/gastos relevantes, botón "Cerrar
 * semana". Sin dashboards avanzados -- ver docs/ETAPA-6-CIERRE-SEMANAL.md.
 */
export function WeeklyClosingPage() {
  const { api } = useAuth();
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [closings, setClosings] = useState<WeeklyClosing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [locationId, setLocationId] = useState('');
  const [weekDate, setWeekDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const periodStart = useMemo(() => mondayOf(weekDate), [weekDate]);

  const loadMasters = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [locationsData, closingsPage] = await Promise.all([
        api.get<LocationSummary[]>('/api/locations'),
        api.get<Page<WeeklyClosing>>('/api/weekly-closings?pageSize=50'),
      ]);
      setLocations(locationsData);
      setClosings(closingsPage.items);
      setLocationId((current) => current || (locationsData[0]?.id ?? ''));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar los datos');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadMasters();
  }, [loadMasters]);

  async function handlePrepare() {
    if (!locationId) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      const created = await api.post<WeeklyClosing>('/api/weekly-closings', {
        locationId,
        periodStart,
      });
      await loadMasters();
      setSelectedId(created.id);
    } catch (err) {
      setPrepareError(
        err instanceof ApiClientError ? err.message : 'No se pudo preparar el cierre',
      );
    } finally {
      setPreparing(false);
    }
  }

  if (loading) return <p>Cargando...</p>;
  if (loadError)
    return (
      <p className="error" role="alert">
        {loadError}
      </p>
    );

  return (
    <div className="catalog-page">
      <h1>Cierre semanal</h1>
      <p className="muted">
        Consolida el estado de una semana (lunes a domingo) por sucursal después de que el conteo
        físico, las mermas, los gastos variables y las ventas importadas ya están cargados. El
        ledger de inventario sigue siendo la única fuente de verdad de stock -- este cierre sólo
        compara y genera un ajuste + una foto histórica al confirmar.
      </p>

      <section className="card">
        <h2>Elegir sucursal y semana</h2>
        <div className="inline-form">
          <label>
            Sucursal
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cualquier día de la semana a cerrar
            <input type="date" value={weekDate} onChange={(e) => setWeekDate(e.target.value)} />
          </label>
          <p className="muted">
            Semana: {periodStart} (lunes) — {periodEndOf(periodStart)} (domingo)
          </p>
          <div className="form-actions">
            <button
              type="button"
              onClick={() => void handlePrepare()}
              disabled={preparing || !locationId}
            >
              {preparing ? 'Preparando...' : 'Ver / preparar cierre de esta semana'}
            </button>
          </div>
        </div>
        {prepareError && (
          <p className="error" role="alert">
            {prepareError}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Cierres</h2>
        {closings.length === 0 ? (
          <p className="empty-state">Todavía no se preparó ningún cierre semanal.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Período</th>
                <th>Estado</th>
                <th>Cerrado por</th>
              </tr>
            </thead>
            <tbody>
              {closings.map((c) => (
                <tr key={c.id} className="movement-row" onClick={() => setSelectedId(c.id)}>
                  <td>{c.locationName}</td>
                  <td>
                    {c.periodStart} — {c.periodEnd}
                  </td>
                  <td>
                    <ClosingStatusBadge status={c.status} />
                  </td>
                  <td>{c.closedByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedId && (
        <WeeklyClosingDetailPanel
          closingId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={loadMasters}
        />
      )}
    </div>
  );
}

/** Lunes de la semana que contiene `dateStr` (YYYY-MM-DD), calculado en
 * horario local del navegador -- evita que el admin tenga que calcularlo a
 * mano; el backend igual valida que el resultado sea un lunes. */
function mondayOf(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  const day = date.getDay(); // 0 = domingo, 1 = lunes, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function periodEndOf(periodStart: string): string {
  const date = new Date(`${periodStart}T00:00:00`);
  date.setDate(date.getDate() + 6);
  return date.toISOString().slice(0, 10);
}

const STATUS_LABELS: Record<WeeklyClosing['status'], string> = {
  OPEN: 'Abierto',
  CLOSED: 'Cerrado',
  REOPENED: 'Reabierto',
};

function ClosingStatusBadge({ status }: { status: WeeklyClosing['status'] }) {
  const className =
    status === 'CLOSED'
      ? 'badge badge-ok'
      : status === 'REOPENED'
        ? 'badge badge-warn'
        : 'badge badge-off';
  return <span className={className}>{STATUS_LABELS[status]}</span>;
}

interface WeeklyClosingDetailPanelProps {
  closingId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function WeeklyClosingDetailPanel({
  closingId,
  onClose,
  onChanged,
}: WeeklyClosingDetailPanelProps) {
  const { api } = useAuth();
  const [detail, setDetail] = useState<WeeklyClosingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirmingReview, setConfirmingReview] = useState(false);
  const [closing, setClosingBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.get<WeeklyClosingDetail>(`/api/weekly-closings/${closingId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el cierre');
    } finally {
      setLoading(false);
    }
  }, [api, closingId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConfirmReview() {
    setConfirmingReview(true);
    setActionError(null);
    try {
      await api.post(`/api/weekly-closings/${closingId}/confirm-review`, {});
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : 'No se pudo confirmar la revisión',
      );
    } finally {
      setConfirmingReview(false);
    }
  }

  async function handleClose() {
    setClosingBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/weekly-closings/${closingId}/close`, {
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : 'No se pudo cerrar la semana');
    } finally {
      setClosingBusy(false);
    }
  }

  async function handleReopen() {
    if (!reopenReason.trim()) {
      setActionError('La reapertura requiere un motivo');
      return;
    }
    setReopening(true);
    setActionError(null);
    try {
      await api.post(`/api/weekly-closings/${closingId}/reopen`, { reason: reopenReason.trim() });
      setReopenReason('');
      await load();
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : 'No se pudo reabrir el cierre');
    } finally {
      setReopening(false);
    }
  }

  if (loading) return <div className="detail-panel">Cargando...</div>;
  if (error || !detail)
    return (
      <div className="detail-panel">
        <p className="error" role="alert">
          {error ?? 'No se pudo cargar el cierre'}
        </p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    );

  const { closing: c, checklist, items } = detail;
  const itemsWithDifference = items.filter((i) => i.difference !== '0.000');

  return (
    <div className="detail-panel">
      <h2>
        {c.locationName} — {c.periodStart} a {c.periodEnd}
      </h2>
      <dl className="detail-grid">
        <dt>Estado</dt>
        <dd>
          <ClosingStatusBadge status={c.status} />
        </dd>
        <dt>Revisión</dt>
        <dd>{detail.revision === 0 ? 'Sin cerrar todavía' : detail.revision}</dd>
        {c.status === 'CLOSED' && (
          <>
            <dt>Cerrado por</dt>
            <dd>
              {c.closedByName} — {c.closedAt ? new Date(c.closedAt).toLocaleString('es-AR') : '—'}
            </dd>
          </>
        )}
        {c.reopenedAt && (
          <>
            <dt>Última reapertura</dt>
            <dd>
              {c.reopenedByName} — {new Date(c.reopenedAt).toLocaleString('es-AR')}
              {c.reopenReason ? ` (${c.reopenReason})` : ''}
            </dd>
          </>
        )}
      </dl>

      <h3>Checklist</h3>
      <dl className="detail-grid">
        <dt>Conteo físico semanal</dt>
        <dd>
          {checklist.countSubmitted
            ? `Completo (semana del ${checklist.governingCountWeekStart})`
            : `Falta (conteo del ${checklist.governingCountWeekStart}, estado: ${checklist.governingCountStatus ?? 'no enviado todavía'})`}
        </dd>
        <dt>Ventas importadas del período</dt>
        <dd>
          {checklist.salesImportsConfirmed} confirmadas de {checklist.salesImportsTotal} cargadas
        </dd>
        <dt>Mermas registradas en el período</dt>
        <dd>{checklist.wastesTotal}</dd>
        <dt>Gastos variables registrados en el período</dt>
        <dd>{checklist.variableExpensesTotal}</dd>
        <dt>Revisión del checklist</dt>
        <dd>
          {checklist.reviewConfirmedById
            ? `Confirmada por ${checklist.reviewConfirmedByName} — ${checklist.reviewConfirmedAt ? new Date(checklist.reviewConfirmedAt).toLocaleString('es-AR') : ''}`
            : 'Pendiente'}
        </dd>
      </dl>

      {c.status !== 'CLOSED' && !checklist.reviewConfirmedById && (
        <div className="form-actions">
          <button
            type="button"
            onClick={() => void handleConfirmReview()}
            disabled={confirmingReview}
          >
            {confirmingReview ? 'Confirmando...' : 'Confirmar que revisé el checklist'}
          </button>
        </div>
      )}

      <h3>
        Teórico vs real ({items.length} producto{items.length === 1 ? '' : 's'} contados,{' '}
        {itemsWithDifference.length} con diferencia)
      </h3>
      {items.length === 0 ? (
        <p className="empty-state">
          Todavía no hay conteo de la semana gobernante para comparar teórico vs real.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Teórico</th>
              <th>Real</th>
              <th>Diferencia</th>
              <th>Ajuste generado</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.productId}>
                <td>{i.productName}</td>
                <td>{i.quantityTheoretical}</td>
                <td>{i.quantityReal}</td>
                <td className={i.difference.startsWith('-') ? 'negative-quantity' : undefined}>
                  {i.difference}
                </td>
                <td>{i.countCorrectionMovementId ? 'Sí' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {c.status !== 'CLOSED' && !checklist.canClose && (
        <p className="muted">
          Todavía no se puede cerrar esta semana: hace falta{' '}
          {!checklist.countSubmitted && 'el conteo físico semanal completo'}
          {!checklist.countSubmitted && !checklist.reviewConfirmedById && ' y '}
          {!checklist.reviewConfirmedById && 'la confirmación de revisión del checklist'}.
        </p>
      )}

      <div className="form-actions">
        {c.status !== 'CLOSED' && (
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={closing || !checklist.canClose}
          >
            {closing ? 'Cerrando...' : 'Cerrar semana'}
          </button>
        )}
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar panel
        </button>
      </div>

      {c.status === 'CLOSED' && (
        <>
          <h3>Reabrir cierre</h3>
          <p className="muted">
            Operación sensible: requiere un motivo y queda auditada. El snapshot de esta revisión se
            conserva; al volver a cerrar se genera una revisión nueva.
          </p>
          <div className="inline-form">
            <label>
              Motivo
              <input
                type="text"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="Ej: corrección de gastos cargados tarde"
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => void handleReopen()} disabled={reopening}>
                {reopening ? 'Reabriendo...' : 'Reabrir'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
