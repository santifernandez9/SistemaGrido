import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type { Category, CreateCategoryInput } from '@sistema-grido/shared-types';

const EMPTY_FORM: CreateCategoryInput = { name: '', parentCategoryId: null };

/**
 * Categorías/grupos de producto (Etapa 2, sección 5). Datos persistidos, no
 * hardcodeados -- el desplegable de "categoría padre" sólo ofrece categorías raíz
 * (grupo → subgrupo, un único nivel, ver docs/ETAPA-2-CATALOGO-MAESTROS.md).
 */
export function CategoriesPage() {
  const { api } = useAuth();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CreateCategoryInput>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      setCategories(await api.get<Category[]>('/api/categories'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las categorías');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootCategories = useMemo(() => categories.filter((c) => !c.parentCategoryId), [categories]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(term));
  }, [categories, search]);

  // Agrupa: cada raíz seguida de sus subcategorías, para mostrar la jerarquía en la tabla.
  const orderedRows = useMemo(() => {
    const byParent = new Map<string, Category[]>();
    for (const c of filtered) {
      if (c.parentCategoryId) {
        const list = byParent.get(c.parentCategoryId) ?? [];
        list.push(c);
        byParent.set(c.parentCategoryId, list);
      }
    }
    const rows: Array<{ category: Category; depth: number }> = [];
    for (const root of filtered.filter((c) => !c.parentCategoryId)) {
      rows.push({ category: root, depth: 0 });
      for (const child of byParent.get(root.id) ?? []) {
        rows.push({ category: child, depth: 1 });
      }
    }
    // Si la búsqueda dejó afuera al padre pero no al hijo, igual mostramos al hijo.
    const shown = new Set(rows.map((r) => r.category.id));
    for (const c of filtered) {
      if (!shown.has(c.id)) rows.push({ category: c, depth: c.parentCategoryId ? 1 : 0 });
    }
    return rows;
  }, [filtered]);

  function startCreate() {
    setEditingId(null);
    setFormState(EMPTY_FORM);
    setFormError(null);
  }

  function startEdit(category: Category) {
    setEditingId(category.id);
    setFormState({ name: category.name, parentCategoryId: category.parentCategoryId });
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingId) {
        await api.patch(`/api/categories/${editingId}`, formState);
      } else {
        await api.post('/api/categories', formState);
      }
      startCreate();
      await loadData();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'No se pudo guardar la categoría');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(category: Category) {
    const verbo = category.active ? 'desactivar' : 'reactivar';
    if (!window.confirm(`¿Seguro que querés ${verbo} "${category.name}"?`)) return;
    try {
      await api.patch(`/api/categories/${category.id}`, { active: !category.active });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar la categoría');
    }
  }

  return (
    <div className="catalog-page">
      <h1>Categorías / grupos</h1>
      <p className="muted">
        Clasificación del catálogo. Un grupo puede tener subgrupos (un único nivel).
      </p>

      <section className="card">
        <h2>{editingId ? 'Editar categoría' : 'Nueva categoría'}</h2>
        <form onSubmit={(event) => void handleSubmit(event)} className="inline-form">
          <label htmlFor="cat-name">Nombre</label>
          <input
            id="cat-name"
            type="text"
            required
            value={formState.name}
            onChange={(event) => setFormState((s) => ({ ...s, name: event.target.value }))}
          />

          <label htmlFor="cat-parent">Grupo padre (opcional, para crear un subgrupo)</label>
          <select
            id="cat-parent"
            value={formState.parentCategoryId ?? ''}
            onChange={(event) =>
              setFormState((s) => ({ ...s, parentCategoryId: event.target.value || null }))
            }
          >
            <option value="">Ninguno (es un grupo de primer nivel)</option>
            {rootCategories
              .filter((c) => c.id !== editingId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>

          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear categoría'}
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
          <h2>Categorías</h2>
          <input
            type="search"
            placeholder="Buscar por nombre..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar categoría"
          />
        </div>
        {loading && <p>Cargando...</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && orderedRows.length === 0 && (
          <p className="empty-state">No hay categorías todavía.</p>
        )}
        {!loading && !error && orderedRows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orderedRows.map(({ category, depth }) => (
                <tr key={category.id}>
                  <td style={depth > 0 ? { paddingLeft: 28 } : undefined}>
                    {depth > 0 ? '↳ ' : ''}
                    {category.name}
                  </td>
                  <td>
                    <span className={`badge ${category.active ? 'badge-ok' : 'badge-off'}`}>
                      {category.active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="secondary" onClick={() => startEdit(category)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void toggleActive(category)}
                    >
                      {category.active ? 'Desactivar' : 'Reactivar'}
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
