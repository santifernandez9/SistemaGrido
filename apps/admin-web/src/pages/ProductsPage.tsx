import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type {
  Category,
  CreateProductInput,
  Flavor,
  Product,
  ProductType,
  UnitOfMeasure,
} from '@sistema-grido/shared-types';

const EMPTY_FORM: CreateProductInput = {
  code: null,
  name: '',
  categoryId: '',
  productTypeId: '',
  unitOfMeasureId: '',
  unitsPerHandlingUnit: 1,
  flavorId: null,
};

/**
 * Catálogo de productos (RF-001, Etapa 2 sección 4). La "presentación" del producto
 * es su unidad de manejo + la cantidad de unidades que contiene (equivalencia) --
 * ver docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Modelo implementado", por qué no
 * hay una pantalla separada de "Presentaciones".
 */
export function ProductsPage() {
  const { api } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [unitsOfMeasure, setUnitsOfMeasure] = useState<UnitOfMeasure[]>([]);
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CreateProductInput>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [productsData, categoriesData, typesData, unitsData, flavorsData] = await Promise.all([
        api.get<Product[]>('/api/products'),
        api.get<Category[]>('/api/categories'),
        api.get<ProductType[]>('/api/product-types'),
        api.get<UnitOfMeasure[]>('/api/units-of-measure'),
        api.get<Flavor[]>('/api/flavors'),
      ]);
      setProducts(productsData);
      setCategories(categoriesData);
      setProductTypes(typesData);
      setUnitsOfMeasure(unitsData);
      setFlavors(flavorsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el catálogo');
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
    return products.filter((p) => {
      if (categoryFilter && p.categoryId !== categoryFilter) return false;
      if (!term) return true;
      return p.name.toLowerCase().includes(term) || (p.code ?? '').toLowerCase().includes(term);
    });
  }, [products, search, categoryFilter]);

  function startCreate() {
    setEditingId(null);
    setFormState({
      ...EMPTY_FORM,
      categoryId: categories[0]?.id ?? '',
      productTypeId: productTypes[0]?.id ?? '',
      unitOfMeasureId: unitsOfMeasure[0]?.id ?? '',
    });
    setFormError(null);
  }

  function startEdit(product: Product) {
    setEditingId(product.id);
    setFormState({
      code: product.code,
      name: product.name,
      categoryId: product.categoryId,
      productTypeId: product.productTypeId,
      unitOfMeasureId: product.unitOfMeasureId,
      unitsPerHandlingUnit: product.unitsPerHandlingUnit,
      flavorId: product.flavorId,
    });
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!Number.isFinite(formState.unitsPerHandlingUnit) || formState.unitsPerHandlingUnit < 1) {
      setFormError('Las unidades por presentación deben ser un número mayor o igual a 1');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = { ...formState, code: formState.code?.trim() || null };
      if (editingId) {
        await api.patch(`/api/products/${editingId}`, payload);
      } else {
        await api.post('/api/products', payload);
      }
      startCreate();
      await loadData();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'No se pudo guardar el producto');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(product: Product) {
    const verbo = product.active ? 'desactivar' : 'reactivar';
    if (!window.confirm(`¿Seguro que querés ${verbo} "${product.name}"?`)) return;
    try {
      await api.patch(`/api/products/${product.id}`, { active: !product.active });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el producto');
    }
  }

  const missingMasters =
    !loading &&
    (categories.length === 0 || productTypes.length === 0 || unitsOfMeasure.length === 0);

  return (
    <div className="catalog-page">
      <h1>Productos</h1>
      <p className="muted">
        Catálogo único de productos. La clave real es interna (UUID); el código es sólo una
        referencia opcional.
      </p>

      {missingMasters && (
        <p className="empty-state">
          Para dar de alta un producto primero hace falta al menos una categoría (ver
          &quot;Categorías / grupos&quot;). Tipos de producto y unidades de manejo ya vienen
          precargados.
        </p>
      )}

      {!missingMasters && (
        <section className="card">
          <h2>{editingId ? 'Editar producto' : 'Nuevo producto'}</h2>
          <form onSubmit={(event) => void handleSubmit(event)} className="inline-form">
            <label htmlFor="prod-code">Código (opcional)</label>
            <input
              id="prod-code"
              type="text"
              value={formState.code ?? ''}
              onChange={(event) =>
                setFormState((s) => ({ ...s, code: event.target.value || null }))
              }
            />

            <label htmlFor="prod-name">Nombre</label>
            <input
              id="prod-name"
              type="text"
              required
              value={formState.name}
              onChange={(event) => setFormState((s) => ({ ...s, name: event.target.value }))}
            />

            <label htmlFor="prod-category">Categoría</label>
            <select
              id="prod-category"
              required
              value={formState.categoryId}
              onChange={(event) => setFormState((s) => ({ ...s, categoryId: event.target.value }))}
            >
              <option value="" disabled>
                Elegir categoría...
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parentCategoryId ? `↳ ${c.name}` : c.name}
                </option>
              ))}
            </select>

            <label htmlFor="prod-type">Tipo</label>
            <select
              id="prod-type"
              required
              value={formState.productTypeId}
              onChange={(event) =>
                setFormState((s) => ({ ...s, productTypeId: event.target.value }))
              }
            >
              <option value="" disabled>
                Elegir tipo...
              </option>
              {productTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <label htmlFor="prod-uom">Unidad de manejo</label>
            <select
              id="prod-uom"
              required
              value={formState.unitOfMeasureId}
              onChange={(event) =>
                setFormState((s) => ({ ...s, unitOfMeasureId: event.target.value }))
              }
            >
              <option value="" disabled>
                Elegir unidad...
              </option>
              {unitsOfMeasure.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>

            <label htmlFor="prod-units">
              Unidades por presentación (equivalencia: cuántas unidades sueltas contiene)
            </label>
            <input
              id="prod-units"
              type="number"
              min={1}
              step={1}
              required
              // No forzar un valor por defecto mientras se edita (event.target.valueAsNumber
              // es NaN con el campo momentáneamente vacío) -- si se forzara acá, borrar el
              // campo para escribir un número nuevo lo auto-rellenaría con "1" a mitad de
              // tipeo. El mínimo real (positivo) lo valida el atributo `min` + `required` del
              // input y, de fondo, el backend (Zod + CHECK de la base de datos).
              value={
                Number.isNaN(formState.unitsPerHandlingUnit) ? '' : formState.unitsPerHandlingUnit
              }
              onChange={(event) =>
                setFormState((s) => ({
                  ...s,
                  unitsPerHandlingUnit: event.target.valueAsNumber,
                }))
              }
            />

            <label htmlFor="prod-flavor">Sabor (opcional)</label>
            <select
              id="prod-flavor"
              value={formState.flavorId ?? ''}
              onChange={(event) =>
                setFormState((s) => ({ ...s, flavorId: event.target.value || null }))
              }
            >
              <option value="">Sin sabor (no aplica a este producto)</option>
              {flavors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
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
                {submitting ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear producto'}
              </button>
              {editingId && (
                <button type="button" className="secondary" onClick={startCreate}>
                  Cancelar
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      <section className="card">
        <div className="list-toolbar">
          <h2>Catálogo</h2>
          <input
            type="search"
            placeholder="Buscar por nombre o código..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar producto"
          />
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            aria-label="Filtrar por categoría"
          >
            <option value="">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {loading && <p>Cargando...</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && filtered.length === 0 && (
          <p className="empty-state">
            {products.length === 0
              ? 'Todavía no hay productos cargados.'
              : 'Ningún producto coincide con la búsqueda.'}
          </p>
        )}
        {!loading && !error && filtered.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th>Categoría</th>
                <th>Tipo</th>
                <th>Unidad</th>
                <th>Equiv.</th>
                <th>Sabor</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((product) => (
                <tr key={product.id}>
                  <td>{product.code ?? '—'}</td>
                  <td>{product.name}</td>
                  <td>{product.categoryName}</td>
                  <td>{product.productTypeName}</td>
                  <td>{product.unitOfMeasureName}</td>
                  <td>{product.unitsPerHandlingUnit}</td>
                  <td>{product.flavorName ?? '—'}</td>
                  <td>
                    <span className={`badge ${product.active ? 'badge-ok' : 'badge-off'}`}>
                      {product.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="secondary" onClick={() => startEdit(product)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void toggleActive(product)}
                    >
                      {product.active ? 'Desactivar' : 'Reactivar'}
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
