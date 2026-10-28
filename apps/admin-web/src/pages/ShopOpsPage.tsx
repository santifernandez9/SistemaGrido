import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@sistema-grido/auth-client';
import type {
  InventoryCount,
  Page,
  StockoutEvent,
  VariableExpense,
  Waste,
} from '@sistema-grido/shared-types';

type Tab = 'conteos' | 'mermas' | 'gastos' | 'sin-stock';

const TABS: { id: Tab; label: string }[] = [
  { id: 'conteos', label: 'Conteos' },
  { id: 'mermas', label: 'Mermas' },
  { id: 'gastos', label: 'Gastos' },
  { id: 'sin-stock', label: 'Sin stock' },
];

/**
 * Vistas de revisión de la App Heladería (Etapa 4, sección 15 del prompt):
 * "vistas mínimas necesarias para revisar conteos/diferencias, mermas y
 * gastos... sin implementar dashboards avanzados, cierre semanal ni
 * reportes de rentabilidad todavía". Sólo lectura -- ninguna acción de
 * escritura (justificar diferencias, aprobar gastos, etc.) se agrega acá,
 * eso queda para una etapa administrativa posterior.
 */
export function ShopOpsPage() {
  const [tab, setTab] = useState<Tab>('conteos');

  return (
    <div className="catalog-page">
      <h1>Heladería — Revisión</h1>
      <p className="muted">
        Vistas de sólo lectura de lo cargado desde la App Heladería: conteos y sus diferencias,
        mermas, gastos variables y avisos de sin stock.
      </p>
      <div className="filters">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === tab ? undefined : 'secondary'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'conteos' && <CountsTab />}
      {tab === 'mermas' && <WasteTab />}
      {tab === 'gastos' && <ExpensesTab />}
      {tab === 'sin-stock' && <StockoutsTab />}
    </div>
  );
}

function CountsTab() {
  const { api } = useAuth();
  const [page, setPage] = useState<Page<InventoryCount> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InventoryCount | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPage(await api.get<Page<InventoryCount>>('/api/shop/counts?pageSize=50'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los conteos');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p>Cargando...</p>;
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!page || page.items.length === 0)
    return <p className="empty-state">No hay conteos cargados.</p>;

  return (
    <section className="card">
      <table>
        <thead>
          <tr>
            <th>Semana</th>
            <th>Ubicación</th>
            <th>Estado</th>
            <th>Cargado por</th>
            <th>Productos con diferencia marcada</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((count) => (
            <tr key={count.id} className="movement-row" onClick={() => setSelected(count)}>
              <td>{count.weekStart}</td>
              <td>{count.locationName}</td>
              <td>{COUNT_STATUS_LABELS[count.status]}</td>
              <td>{count.createdByName}</td>
              <td>{count.items.filter((i) => i.needsRecount).length}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div className="detail-panel">
          <h2>
            Conteo — {selected.locationName} — semana del {selected.weekStart}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Físico</th>
                <th>Teórico</th>
                <th>Diferencia</th>
                <th>¿Necesitó reconteo?</th>
              </tr>
            </thead>
            <tbody>
              {selected.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.productName}</td>
                  <td>{item.physicalQuantity}</td>
                  <td>{item.theoreticalQuantity ?? '—'}</td>
                  <td className={Number(item.difference) < 0 ? 'negative-quantity' : undefined}>
                    {item.difference ?? '—'}
                  </td>
                  <td>
                    {item.needsRecount
                      ? item.recounted
                        ? 'Sí, recontado'
                        : 'Sí, pendiente'
                      : 'No'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => setSelected(null)}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const COUNT_STATUS_LABELS: Record<InventoryCount['status'], string> = {
  DRAFT: 'Borrador',
  SUBMITTED: 'Enviado',
  RECOUNT_REQUIRED: 'Esperando reconteo',
  COMPLETED: 'Completado',
};

function WasteTab() {
  const { api } = useAuth();
  const [items, setItems] = useState<Waste[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Waste[]>('/api/shop/waste')
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'No se pudo cargar'))
      .finally(() => setLoading(false));
  }, [api]);

  if (loading) return <p>Cargando...</p>;
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (items.length === 0) return <p className="empty-state">No hay mermas registradas.</p>;

  return (
    <section className="card">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Ubicación</th>
            <th>Producto</th>
            <th>Cantidad</th>
            <th>Motivo</th>
            <th>Usuario</th>
            <th>Foto</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id}>
              <td>{formatDate(w.occurredAt)}</td>
              <td>{w.locationName}</td>
              <td>{w.productName}</td>
              <td>{w.quantity}</td>
              <td>{w.reason}</td>
              <td>{w.createdByName}</td>
              <td>
                {w.photoUrl ? (
                  <a href={w.photoUrl} target="_blank" rel="noreferrer">
                    Ver foto
                  </a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ExpensesTab() {
  const { api } = useAuth();
  const [items, setItems] = useState<VariableExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<VariableExpense[]>('/api/shop/expenses')
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'No se pudo cargar'))
      .finally(() => setLoading(false));
  }, [api]);

  if (loading) return <p>Cargando...</p>;
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (items.length === 0) return <p className="empty-state">No hay gastos registrados.</p>;

  return (
    <section className="card">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Ubicación</th>
            <th>Categoría</th>
            <th>Descripción</th>
            <th>Monto</th>
            <th>Usuario</th>
            <th>Comprobante</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{formatDate(e.occurredAt)}</td>
              <td>{e.locationName}</td>
              <td>{e.category}</td>
              <td>{e.description}</td>
              <td>${e.amount}</td>
              <td>{e.createdByName}</td>
              <td>
                {e.receiptUrl ? (
                  <a href={e.receiptUrl} target="_blank" rel="noreferrer">
                    Ver comprobante
                  </a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  URGENT_RESTOCK: 'Reposición urgente posible',
  SUPPLY_SHORTAGE: 'Faltante de abastecimiento',
};

function StockoutsTab() {
  const { api } = useAuth();
  const [items, setItems] = useState<StockoutEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<StockoutEvent[]>('/api/shop/stockouts')
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'No se pudo cargar'))
      .finally(() => setLoading(false));
  }, [api]);

  if (loading) return <p>Cargando...</p>;
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (items.length === 0) return <p className="empty-state">No hay avisos de sin stock.</p>;

  return (
    <section className="card">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Ubicación</th>
            <th>Producto</th>
            <th>Clasificación</th>
            <th>Usuario</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td>{formatDate(s.occurredAt)}</td>
              <td>{s.locationName}</td>
              <td>{s.productName}</td>
              <td>{s.classification ? CLASSIFICATION_LABELS[s.classification] : '—'}</td>
              <td>{s.createdByName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-AR');
}
