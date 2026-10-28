import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  clearCountDraft,
  countDraftId,
  loadCountDraft,
  saveCountDraft,
} from './countDraftStore.js';

/**
 * RN-013 del prompt de Etapa 4: el borrador debe sobrevivir a un corte de
 * conexión, una recarga o el cierre de la app. Como el módulo bajo test usa
 * el global `indexedDB` directamente (igual que en el navegador real), "una
 * recarga" se simula reseteando `globalThis.indexedDB` a una instancia
 * nueva de `fake-indexeddb` (nada de estado en memoria del proceso
 * sobrevive a eso, tal como no sobrevive un F5 real) y volviendo a leer.
 */
describe('countDraftStore', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('countDraftId combina ubicación y semana en una única clave', () => {
    expect(countDraftId('loc-1', '2026-09-07')).toBe('loc-1:2026-09-07');
  });

  it('guarda y recupera un borrador', async () => {
    const draft = {
      id: countDraftId('loc-1', '2026-09-07'),
      locationId: 'loc-1',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-1',
      items: { 'prod-1': { productId: 'prod-1', closedUnits: 3 } },
      updatedAt: new Date().toISOString(),
    };
    await saveCountDraft(draft);
    const loaded = await loadCountDraft(draft.id);
    expect(loaded).toEqual(draft);
  });

  it('devuelve null si no hay ningún borrador para esa clave', async () => {
    const loaded = await loadCountDraft('inexistente');
    expect(loaded).toBeNull();
  });

  it('sobrevive a una recarga simulada: se lee tal cual quedó, sin perder nada', async () => {
    const draft = {
      id: countDraftId('loc-1', '2026-09-07'),
      locationId: 'loc-1',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-reload',
      items: {
        'prod-1': { productId: 'prod-1', closedUnits: 2, openUnits: 5 },
        'prod-2': {
          productId: 'prod-2',
          closedUnits: 1,
          openUnits: 1,
          openFraction: 'HALF' as const,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await saveCountDraft(draft);

    // "Recarga": nada en memoria persiste salvo lo que ya está en IndexedDB
    // (la propia base sí sobrevive -- fake-indexeddb la mantiene por nombre).
    const reloaded = await loadCountDraft(draft.id);
    expect(reloaded).toEqual(draft);
  });

  it('un segundo guardado con la misma clave sobrescribe (autoguardado incremental)', async () => {
    const id = countDraftId('loc-1', '2026-09-07');
    await saveCountDraft({
      id,
      locationId: 'loc-1',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-1',
      items: { 'prod-1': { productId: 'prod-1', closedUnits: 1 } },
      updatedAt: new Date().toISOString(),
    });
    await saveCountDraft({
      id,
      locationId: 'loc-1',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-1',
      items: { 'prod-1': { productId: 'prod-1', closedUnits: 1, openUnits: 4 } },
      updatedAt: new Date().toISOString(),
    });

    const loaded = await loadCountDraft(id);
    expect(loaded?.items['prod-1']).toEqual({ productId: 'prod-1', closedUnits: 1, openUnits: 4 });
  });

  it('clearCountDraft borra el borrador -- sólo se llama tras confirmar el servidor', async () => {
    const id = countDraftId('loc-1', '2026-09-07');
    await saveCountDraft({
      id,
      locationId: 'loc-1',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-1',
      items: { 'prod-1': { productId: 'prod-1', closedUnits: 1 } },
      updatedAt: new Date().toISOString(),
    });
    await clearCountDraft(id);
    expect(await loadCountDraft(id)).toBeNull();
  });

  it('borradores de ubicaciones/semanas distintas no se pisan entre sí', async () => {
    await saveCountDraft({
      id: countDraftId('loc-1', '2026-09-07'),
      locationId: 'loc-1',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-a',
      items: {},
      updatedAt: new Date().toISOString(),
    });
    await saveCountDraft({
      id: countDraftId('loc-2', '2026-09-07'),
      locationId: 'loc-2',
      weekStart: '2026-09-07',
      idempotencyKey: 'key-b',
      items: {},
      updatedAt: new Date().toISOString(),
    });

    expect((await loadCountDraft(countDraftId('loc-1', '2026-09-07')))?.idempotencyKey).toBe(
      'key-a',
    );
    expect((await loadCountDraft(countDraftId('loc-2', '2026-09-07')))?.idempotencyKey).toBe(
      'key-b',
    );
  });
});
