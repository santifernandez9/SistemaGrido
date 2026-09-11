import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import {
  PRICE_LIST_SOURCES,
  PRICE_TYPES,
  type Page,
  type PriceListImport,
  type PriceListImportPreview,
  type PriceListSource,
  type PriceReference,
  type PriceReferenceProductMapping,
  type PriceType,
  type Product,
} from '@sistema-grido/shared-types';

/**
 * "Precios" (Etapa 6.2, sección 18 del prompt: "función/claridad, sin
 * rediseño visual general") -- pantalla mínima obligatoria: subir listas de
 * costo/venta de Helacor, ver preview, confirmar (con `effectiveFrom`
 * SIEMPRE explícito, nunca inferido del rótulo del archivo -- ver
 * docs/ETAPA-6.2-CIERRE-INTEGRAL.md), y administrar las referencias de
 * precio/costo y sus mapeos a productos del catálogo (una referencia puede
 * mapear a VARIOS productos, nunca 1:1 forzado).
 */
export function PriceListPage() {
  const { api } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [imports, setImports] = useState<PriceListImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [source, setSource] = useState<PriceListSource>(PRICE_LIST_SOURCES[0]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);

  const loadMasters = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [productsData, importsPage] = await Promise.all([
        api.get<Product[]>('/api/products'),
        api.get<Page<PriceListImport>>('/api/price-list-imports?pageSize=50'),
      ]);
      setProducts(productsData);
      setImports(importsPage.items);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar los datos');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadMasters();
  }, [loadMasters]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  async function handleUpload(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setUploadError('Elegí un archivo para subir');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('source', source);
      formData.append('file', file);
      const created = await api.postFormData<PriceListImport>('/api/price-list-imports', formData);
      setFile(null);
      await loadMasters();
      setSelectedImportId(created.id);
    } catch (err) {
      setUploadError(err instanceof ApiClientError ? err.message : 'No se pudo subir el archivo');
    } finally {
      setUploading(false);
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
      <h1>Precios</h1>
      <p className="muted">
        Listas de costo y de precio de venta de Helacor. La vigencia (`effectiveFrom`) siempre la
        indica el ADMIN al confirmar -- nunca se infiere del rótulo de período del archivo. Sólo se
        crean/actualizan referencias y valores de precio al confirmar; la vista previa nunca
        modifica nada.
      </p>

      <section className="card">
        <h2>Nueva importación</h2>
        <form className="inline-form" onSubmit={(e) => void handleUpload(e)}>
          <label>
            Tipo de lista
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as PriceListSource)}
              required
            >
              {PRICE_LIST_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Archivo (.xlsx)
            <input type="file" accept=".xlsx" onChange={handleFileChange} required />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={uploading}>
              {uploading ? 'Subiendo...' : 'Subir'}
            </button>
          </div>
        </form>
        {uploadError && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Importaciones</h2>
        {imports.length === 0 ? (
          <p className="empty-state">Todavía no se subió ninguna lista de precios/costos.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Archivo</th>
                <th>Período (archivo)</th>
                <th>Filas</th>
                <th>Vigencia</th>
                <th>Estado</th>
                <th>Confirmado por</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr
                  key={imp.id}
                  className="movement-row"
                  onClick={() => setSelectedImportId(imp.id)}
                >
                  <td>{new Date(imp.createdAt).toLocaleString('es-AR')}</td>
                  <td>{SOURCE_LABELS[imp.source]}</td>
                  <td>{imp.originalFilename}</td>
                  <td>{imp.rawPeriodLabel ?? '—'}</td>
                  <td>
                    {imp.validRows}/{imp.totalRows}
                    {imp.errorRows > 0 ? ` (${imp.errorRows} con error)` : ''}
                  </td>
                  <td>{imp.effectiveFrom ?? '—'}</td>
                  <td>
                    <ImportStatusBadge status={imp.status} />
                  </td>
                  <td>{imp.confirmedByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedImportId && (
        <PriceListImportDetail
          importId={selectedImportId}
          onClose={() => setSelectedImportId(null)}
          onChanged={loadMasters}
        />
      )}

      <PriceReferencesSection products={products} />
    </div>
  );
}

const SOURCE_LABELS: Record<PriceListSource, string> = {
  HELACOR_COST_LIST: 'Lista de costos',
  HELACOR_SALE_PRICE_LIST: 'Lista de precios de venta',
};

const IMPORT_STATUS_LABELS: Record<PriceListImport['status'], string> = {
  UPLOADED: 'Subido',
  PREVIEW_READY: 'Listo para confirmar',
  CONFIRMED: 'Confirmado',
  FAILED: 'Falló',
};

function ImportStatusBadge({ status }: { status: PriceListImport['status'] }) {
  const className =
    status === 'CONFIRMED' || status === 'PREVIEW_READY'
      ? 'badge badge-ok'
      : status === 'FAILED'
        ? 'badge badge-warn'
        : 'badge badge-off';
  return <span className={className}>{IMPORT_STATUS_LABELS[status]}</span>;
}

interface PriceListImportDetailProps {
  importId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function PriceListImportDetail({ importId, onClose, onChanged }: PriceListImportDetailProps) {
  const { api } = useAuth();
  const [preview, setPreview] = useState<PriceListImportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPreview(await api.get<PriceListImportPreview>(`/api/price-list-imports/${importId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la importación');
    } finally {
      setLoading(false);
    }
  }, [api, importId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConfirm() {
    if (!effectiveFrom) {
      setConfirmError('Indicá la fecha de vigencia');
      return;
    }
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.post(`/api/price-list-imports/${importId}/confirm`, {
        idempotencyKey: crypto.randomUUID(),
        effectiveFrom,
      });
      await load();
      await onChanged();
    } catch (err) {
      setConfirmError(err instanceof ApiClientError ? err.message : 'No se pudo confirmar');
    } finally {
      setConfirming(false);
    }
  }

  if (loading) return <div className="detail-panel">Cargando...</div>;
  if (error || !preview)
    return (
      <div className="detail-panel">
        <p className="error" role="alert">
          {error ?? 'No se pudo cargar la importación'}
        </p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    );

  const errorRows = preview.rows.filter((r) => r.status === 'ERROR');

  return (
    <div className="detail-panel">
      <h2>
        {preview.import.originalFilename} — {SOURCE_LABELS[preview.import.source]}
      </h2>
      <dl className="detail-grid">
        <dt>Estado</dt>
        <dd>
          <ImportStatusBadge status={preview.import.status} />
        </dd>
        <dt>Período (rótulo del archivo)</dt>
        <dd>{preview.import.rawPeriodLabel ?? '—'}</dd>
        <dt>Filas totales</dt>
        <dd>{preview.import.totalRows}</dd>
        <dt>Filas válidas</dt>
        <dd>{preview.import.validRows}</dd>
        <dt>Filas con error</dt>
        <dd>{preview.import.errorRows}</dd>
        <dt>Referencias nuevas</dt>
        <dd>{preview.newReferenceCount}</dd>
        <dt>Referencias existentes</dt>
        <dd>{preview.existingReferenceCount}</dd>
        <dt>Referencias sin mapear</dt>
        <dd>{preview.unmappedReferenceCount}</dd>
        <dt>Vigencia confirmada</dt>
        <dd>{preview.import.effectiveFrom ?? '—'}</dd>
        <dt>Confirmado por</dt>
        <dd>
          {preview.import.confirmedByName
            ? `${preview.import.confirmedByName} — ${preview.import.confirmedAt ? new Date(preview.import.confirmedAt).toLocaleString('es-AR') : ''}`
            : '—'}
        </dd>
      </dl>

      {preview.import.failedReason && (
        <p className="error" role="alert">
          {preview.import.failedReason}
        </p>
      )}

      <h3>Filas ({preview.rows.length})</h3>
      {preview.rows.length === 0 ? (
        <p className="empty-state">El archivo no tiene filas.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fila</th>
              <th>Descripción</th>
              <th>Categoría</th>
              <th>Precio S/IVA</th>
              <th>Precio C/IVA</th>
              <th>Referencia</th>
              <th>Mapeada</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.rowNumber}</td>
                <td>{row.rawLabel}</td>
                <td>{row.rawCategory ?? '—'}</td>
                <td>{row.rawValueWithoutTax ?? '—'}</td>
                <td>{row.rawValueWithTax ?? '—'}</td>
                <td>{row.existingPriceReferenceId ? 'Existente' : 'Nueva'}</td>
                <td>{row.isMapped ? 'Sí' : 'No'}</td>
                <td className={row.status === 'ERROR' ? 'negative-quantity' : undefined}>
                  {row.status === 'ERROR' ? (row.errorMessage ?? 'Error') : 'Válida'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {errorRows.length > 0 && (
        <p className="muted">{errorRows.length} fila(s) con error -- no se importan.</p>
      )}

      {confirmError && (
        <p className="error" role="alert">
          {confirmError}
        </p>
      )}

      {preview.import.status === 'PREVIEW_READY' && (
        <div className="inline-form">
          <label>
            Vigencia desde (indicada por el ADMIN, no se infiere del archivo)
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              required
            />
          </label>
          <div className="form-actions">
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={confirming || !preview.canConfirm || !effectiveFrom}
            >
              {confirming ? 'Confirmando...' : 'Confirmar importación'}
            </button>
          </div>
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}

interface PriceReferencesSectionProps {
  products: Product[];
}

function PriceReferencesSection({ products }: PriceReferencesSectionProps) {
  const { api } = useAuth();
  const [priceType, setPriceType] = useState<PriceType>(PRICE_TYPES[0]);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [references, setReferences] = useState<PriceReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ priceType });
      if (onlyUnmapped) params.set('onlyUnmapped', 'true');
      setReferences(await api.get<PriceReference[]>(`/api/price-references?${params.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las referencias');
    } finally {
      setLoading(false);
    }
  }, [api, priceType, onlyUnmapped]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedReference = references.find((r) => r.id === selectedReferenceId) ?? null;

  return (
    <section className="card">
      <h2>Referencias y mapeos</h2>
      <p className="muted">
        Una referencia de precio/costo puede mapear a uno o varios productos del catálogo -- nunca
        se fuerza una relación 1:1.
      </p>
      <div className="filters">
        {PRICE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={t === priceType ? undefined : 'secondary'}
            onClick={() => {
              setPriceType(t);
              setSelectedReferenceId(null);
            }}
          >
            {PRICE_TYPE_LABELS[t]}
          </button>
        ))}
        <label>
          <input
            type="checkbox"
            checked={onlyUnmapped}
            onChange={(e) => setOnlyUnmapped(e.target.checked)}
          />{' '}
          Sólo sin mapear
        </label>
      </div>

      {loading ? (
        <p>Cargando...</p>
      ) : error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : references.length === 0 ? (
        <p className="empty-state">No hay referencias para este filtro.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Etiqueta</th>
              <th>Categoría</th>
              <th>Valor vigente</th>
              <th>Vigente desde</th>
              <th>Productos mapeados</th>
              <th>Activa</th>
            </tr>
          </thead>
          <tbody>
            {references.map((r) => (
              <tr key={r.id} className="movement-row" onClick={() => setSelectedReferenceId(r.id)}>
                <td>{r.label}</td>
                <td>{r.sourceCategory ?? '—'}</td>
                <td>{r.currentValue ?? '—'}</td>
                <td>{r.currentValueEffectiveFrom ?? '—'}</td>
                <td>{r.mappedProductCount}</td>
                <td>
                  <span className={r.active ? 'badge badge-ok' : 'badge badge-off'}>
                    {r.active ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedReference && (
        <PriceReferenceMappingsPanel
          reference={selectedReference}
          products={products}
          onClose={() => setSelectedReferenceId(null)}
          onChanged={load}
        />
      )}
    </section>
  );
}

const PRICE_TYPE_LABELS: Record<PriceType, string> = {
  COST_WITH_TAX: 'Costos',
  SALE_PRICE: 'Precios de venta',
};

interface PriceReferenceMappingsPanelProps {
  reference: PriceReference;
  products: Product[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function PriceReferenceMappingsPanel({
  reference,
  products,
  onClose,
  onChanged,
}: PriceReferenceMappingsPanelProps) {
  const { api } = useAuth();
  const [mappings, setMappings] = useState<PriceReferenceProductMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newProductId, setNewProductId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMappings(
        await api.get<PriceReferenceProductMapping[]>(
          `/api/price-reference-product-mappings?priceReferenceId=${reference.id}`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los mapeos');
    } finally {
      setLoading(false);
    }
  }, [api, reference.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAddMapping() {
    if (!newProductId) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.post('/api/price-reference-product-mappings', {
        priceReferenceId: reference.id,
        productId: newProductId,
      });
      setNewProductId('');
      await load();
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : 'No se pudo crear el mapeo');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate(mappingId: string) {
    setDeactivatingId(mappingId);
    setActionError(null);
    try {
      await api.post(`/api/price-reference-product-mappings/${mappingId}/deactivate`, {});
      await load();
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : 'No se pudo desactivar');
    } finally {
      setDeactivatingId(null);
    }
  }

  return (
    <div className="detail-panel">
      <h3>Mapeos de "{reference.label}"</h3>
      {loading ? (
        <p>Cargando...</p>
      ) : error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : mappings.length === 0 ? (
        <p className="empty-state">Esta referencia todavía no tiene ningún producto mapeado.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Estado</th>
              <th>Confirmado por</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id}>
                <td>{m.productName}</td>
                <td>
                  <span className={m.active ? 'badge badge-ok' : 'badge badge-off'}>
                    {m.active ? 'Activo' : 'Inactivo'}
                  </span>
                </td>
                <td>{m.confirmedByName}</td>
                <td>
                  {m.active && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={deactivatingId === m.id}
                      onClick={() => void handleDeactivate(m.id)}
                    >
                      {deactivatingId === m.id ? 'Desactivando...' : 'Desactivar'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="inline-form">
        <label>
          Agregar mapeo a producto
          <select value={newProductId} onChange={(e) => setNewProductId(e.target.value)}>
            <option value="">Elegir producto...</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button
            type="button"
            onClick={() => void handleAddMapping()}
            disabled={submitting || !newProductId}
          >
            {submitting ? 'Agregando...' : 'Agregar mapeo'}
          </button>
        </div>
      </div>

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
