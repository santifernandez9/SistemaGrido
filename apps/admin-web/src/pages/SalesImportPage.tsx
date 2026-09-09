import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type {
  LocationSummary,
  Page,
  Product,
  SalesImport,
  SalesImportPreview,
} from '@sistema-grido/shared-types';

/**
 * "Ventas / Importar ventas" (Etapa 5, sección 20 del prompt) -- pantalla
 * mínima obligatoria: elegir ubicación, seleccionar archivo, subir, ver
 * preview, revisar errores, ver mapeados/no mapeados, ver cantidad de filas,
 * ver total de ventas/importes, confirmar. Sin dashboard comercial avanzado
 * ni rentabilidad completa (eso queda fuera de Hito 1, ver
 * docs/ETAPA-5-IMPORTADOR-VENTAS.md).
 */
export function SalesImportPage() {
  const { api } = useAuth();
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [imports, setImports] = useState<SalesImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [locationId, setLocationId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadMasters = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [locationsData, productsData, importsPage] = await Promise.all([
        api.get<LocationSummary[]>('/api/locations'),
        api.get<Product[]>('/api/products'),
        api.get<Page<SalesImport>>('/api/sales-imports?pageSize=50'),
      ]);
      setLocations(locationsData);
      setProducts(productsData);
      setImports(importsPage.items);
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
      formData.append('locationId', locationId);
      formData.append('file', file);
      const created = await api.postFormData<SalesImport>('/api/sales-imports', formData);
      setFile(null);
      await loadMasters();
      setSelectedId(created.id);
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
      <h1>Ventas — Importar ventas</h1>
      <p className="muted">
        Subí el reporte "Mix de Ventas" del POS (exportado con el filtro "Precios: Desagrupados").
        La facturación usa siempre el importe real del archivo, nunca un precio de lista. Sólo se
        generan movimientos de stock al confirmar -- la vista previa nunca modifica stock.
      </p>

      <section className="card">
        <h2>Nueva importación</h2>
        <form className="inline-form" onSubmit={(e) => void handleUpload(e)}>
          <label>
            Ubicación
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Archivo (.xls)
            <input type="file" accept=".xls" onChange={handleFileChange} required />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={uploading || !locationId}>
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
          <p className="empty-state">Todavía no se subió ningún archivo de ventas.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Ubicación</th>
                <th>Archivo</th>
                <th>Período</th>
                <th>Filas</th>
                <th>Total</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="movement-row" onClick={() => setSelectedId(imp.id)}>
                  <td>{new Date(imp.createdAt).toLocaleString('es-AR')}</td>
                  <td>{imp.locationName}</td>
                  <td>{imp.originalFilename}</td>
                  <td>
                    {imp.periodStart} — {imp.periodEnd}
                  </td>
                  <td>
                    {imp.validRows}/{imp.totalRows}
                  </td>
                  <td>${imp.totalAmount}</td>
                  <td>
                    <StatusBadge status={imp.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedId && (
        <SalesImportDetail
          importId={selectedId}
          products={products}
          onClose={() => setSelectedId(null)}
          onChanged={loadMasters}
        />
      )}
    </div>
  );
}

const STATUS_LABELS: Record<SalesImport['status'], string> = {
  UPLOADED: 'Subido',
  PREVIEW_READY: 'Listo para confirmar',
  BLOCKED: 'Bloqueado',
  CONFIRMED: 'Confirmado',
  FAILED: 'Falló',
};

function StatusBadge({ status }: { status: SalesImport['status'] }) {
  const className =
    status === 'CONFIRMED' || status === 'PREVIEW_READY'
      ? 'badge badge-ok'
      : status === 'BLOCKED' || status === 'FAILED'
        ? 'badge badge-warn'
        : 'badge badge-off';
  return <span className={className}>{STATUS_LABELS[status]}</span>;
}

interface SalesImportDetailProps {
  importId: string;
  products: Product[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function SalesImportDetail({ importId, products, onClose, onChanged }: SalesImportDetailProps) {
  const { api } = useAuth();
  const [preview, setPreview] = useState<SalesImportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [aliasProductByCode, setAliasProductByCode] = useState<Record<string, string>>({});
  const [aliasSubmitting, setAliasSubmitting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPreview(await api.get<SalesImportPreview>(`/api/sales-imports/${importId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la importación');
    } finally {
      setLoading(false);
    }
  }, [api, importId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreateAlias(rawArticleCode: string) {
    const productId = aliasProductByCode[rawArticleCode];
    if (!productId) return;
    setAliasSubmitting(rawArticleCode);
    try {
      await api.post('/api/product-aliases', {
        source: 'MIX_VENTAS',
        externalCode: rawArticleCode,
        productId,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'No se pudo mapear el producto');
    } finally {
      setAliasSubmitting(null);
    }
  }

  async function handleConfirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.post(`/api/sales-imports/${importId}/confirm`, {
        idempotencyKey: crypto.randomUUID(),
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
        {preview.import.originalFilename} — {preview.import.locationName}
      </h2>
      <dl className="detail-grid">
        <dt>Estado</dt>
        <dd>
          <StatusBadge status={preview.import.status} />
        </dd>
        <dt>Período</dt>
        <dd>
          {preview.import.periodStart} — {preview.import.periodEnd}
        </dd>
        <dt>Filas totales</dt>
        <dd>{preview.import.totalRows}</dd>
        <dt>Filas válidas</dt>
        <dd>{preview.import.validRows}</dd>
        <dt>Filas con error</dt>
        <dd>{preview.import.errorRows}</dd>
        <dt>Cantidad total (filas válidas)</dt>
        <dd>{preview.import.totalQuantity}</dd>
        <dt>Importe total (filas válidas)</dt>
        <dd>${preview.import.totalAmount}</dd>
        <dt>Total declarado por el archivo</dt>
        <dd>{preview.import.fileStatedTotal ? `$${preview.import.fileStatedTotal}` : '—'}</dd>
      </dl>

      {preview.import.blockedReason && (
        <p className="error" role="alert">
          {preview.import.blockedReason}
        </p>
      )}
      {preview.import.failedReason && (
        <p className="error" role="alert">
          {preview.import.failedReason}
        </p>
      )}

      {preview.potentialDuplicateRowNumbers.length > 0 && (
        <p className="muted">
          Posibles filas duplicadas (mismo artículo/cantidad/importe/promoción):{' '}
          {preview.potentialDuplicateRowNumbers.join(', ')}
        </p>
      )}

      <h3>Productos reconocidos ({preview.mappedProducts.length})</h3>
      {preview.mappedProducts.length === 0 ? (
        <p className="empty-state">Todavía ningún código quedó mapeado a un producto.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Filas</th>
            </tr>
          </thead>
          <tbody>
            {preview.mappedProducts.map((m) => (
              <tr key={m.productId}>
                <td>{m.productName}</td>
                <td>{m.rowCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Productos sin mapear ({preview.unmappedCodes.length})</h3>
      {preview.unmappedCodes.length === 0 ? (
        <p className="empty-state">No hay códigos sin mapear.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Descripción (POS)</th>
              <th>Filas</th>
              <th>Mapear a</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {preview.unmappedCodes.map((u) => (
              <tr key={u.rawArticleCode}>
                <td>{u.rawArticleCode}</td>
                <td>{u.rawDescription}</td>
                <td>{u.rowCount}</td>
                <td>
                  <select
                    value={aliasProductByCode[u.rawArticleCode] ?? ''}
                    onChange={(e) =>
                      setAliasProductByCode((s) => ({
                        ...s,
                        [u.rawArticleCode]: e.target.value,
                      }))
                    }
                  >
                    <option value="">Elegir producto...</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    disabled={
                      !aliasProductByCode[u.rawArticleCode] || aliasSubmitting === u.rawArticleCode
                    }
                    onClick={() => void handleCreateAlias(u.rawArticleCode)}
                  >
                    Confirmar mapeo
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {errorRows.length > 0 && (
        <>
          <h3>Filas con error ({errorRows.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Fila</th>
                <th>Artículo</th>
                <th>Descripción</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {errorRows.map((r) => (
                <tr key={r.id}>
                  <td>{r.rowNumber}</td>
                  <td>{r.rawArticleCode}</td>
                  <td>{r.rawDescription}</td>
                  <td className="negative-quantity">{r.errorMessage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {confirmError && (
        <p className="error" role="alert">
          {confirmError}
        </p>
      )}

      <div className="form-actions">
        {preview.canConfirm && (
          <button type="button" onClick={() => void handleConfirm()} disabled={confirming}>
            {confirming ? 'Confirmando...' : 'Confirmar importación'}
          </button>
        )}
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
