import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type { CreateFlavorInput, Flavor } from '@sistema-grido/shared-types';

const EMPTY_FORM: CreateFlavorInput = { name: '' };

/**
 * Sabores de helado (RF-003/RN-003, Etapa 2 sección 6). No implementa consumo por
 * sabor ni movimientos -- eso es motor de inventario, de una etapa posterior.
 */
export function FlavorsPage() {
  const { api } = useAuth();
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CreateFlavorInput>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      setFlavors(await api.get<Flavor[]>('/api/flavors'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los sabores');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return flavors;
    return flavors.filter((f) => f.name.toLowerCase().includes(term));
  }, [flavors, search]);

  function startCreate() {
    setEditingId(null);
    setFormState(EMPTY_FORM);
    setFormError(null);
  }

  function startEdit(flavor: Flavor) {
    setEditingId(flavor.id);
    setFormState({ name: flavor.name });
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingId) {
        await api.patch(`/api/flavors/${editingId}`, formState);
      } else {
        await api.post('/api/flavors', formState);
      }
      startCreate();
      await loadData();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'No se pudo guardar el sabor');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(flavor: Flavor) {
    const verbo = flavor.active ? 'desactivar' : 'reactivar';
    if (!window.confirm(`¿Seguro que querés ${verbo} el sabor "${flavor.name}"?`)) return;
    try {
      await api.patch(`/api/flavors/${flavor.id}`, { active: !flavor.active });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el sabor');
    }
  }

  return (
    <div className="catalog-page">
      <h1>Sabores</h1>
      <p className="muted">
        Cada sabor de helado se cuenta y analiza individualmente, aunque comparta grupo.
      </p>

      <section className="card">
        <h2>{editingId ? 'Editar sabor' : 'Nuevo sabor'}</h2>
        <form onSubmit={(event) => void handleSubmit(event)} className="inline-form">
          <label htmlFor="flavor-name">Nombre</label>
          <input
            id="flavor-name"
            type="text"
            required
            value={formState.name}
            onChange={(event) => setFormState({ name: event.target.value })}
          />

          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear sabor'}
            </button>
            {editingId && (
              <button type="button" className="secondary" onClick={startCreate}>
                Cancelar
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="card">
        <div className="list-toolbar">
          <h2>Sabores</h2>
          <input
            type="search"
            placeholder="Buscar por nombre..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar sabor"
          />
        </div>
        {loading && <p>Cargando...</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && filtered.length === 0 && (
          <p className="empty-state">No hay sabores todavía.</p>
        )}
        {!loading && !error && filtered.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((flavor) => (
                <tr key={flavor.id}>
                  <td>{flavor.name}</td>
                  <td>
                    <span className={`badge ${flavor.active ? 'badge-ok' : 'badge-off'}`}>
                      {flavor.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="secondary" onClick={() => startEdit(flavor)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void toggleActive(flavor)}
                    >
                      {flavor.active ? 'Desactivar' : 'Reactivar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
