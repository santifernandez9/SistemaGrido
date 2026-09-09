import type { InventoryCountDraftItem } from '@sistema-grido/shared-types';

/**
 * Borrador local del conteo físico semanal (RN-013 del prompt de Etapa 4:
 * "el sistema debe guardar localmente... y sobrevivir a un corte de
 * conexión, recarga accidental o cierre de la app"). Vive ENTERAMENTE en
 * IndexedDB del dispositivo -- no hay ningún endpoint de "guardar borrador"
 * en el backend (ver docs/ETAPA-4-APP-HELADERIA.md, "Autoguardado"): el
 * servidor sólo recibe el conteo ya terminado, vía `submitInventoryCount`.
 *
 * El borrador SÓLO se borra después de que el servidor confirma el envío
 * (`clearCountDraft`, llamado desde CountPage tras un 2xx) -- nunca antes,
 * y nunca simplemente porque el usuario cerró la pantalla.
 */

const DB_NAME = 'sistema-grido-shop-drafts';
const DB_VERSION = 1;
const STORE = 'inventory_counts';

export interface CountDraft {
  /** `${locationId}:${weekStart}` -- a lo sumo un conteo en curso por ubicación/semana. */
  id: string;
  locationId: string;
  weekStart: string;
  idempotencyKey: string;
  items: Record<string, InventoryCountDraftItem>;
  updatedAt: string;
}

export function countDraftId(locationId: string, weekStart: string): string {
  return `${locationId}:${weekStart}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

export async function saveCountDraft(draft: CountDraft): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(draft);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}

export async function loadCountDraft(id: string): Promise<CountDraft | null> {
  const db = await openDb();
  try {
    return await new Promise<CountDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as CountDraft | undefined) ?? null);
      request.onerror = () => reject(request.error as Error);
    });
  } finally {
    db.close();
  }
}

export async function clearCountDraft(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}
