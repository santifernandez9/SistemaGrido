import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Estrategia de actualización segura del service worker (sección 13 del prompt de
 * Etapa 1: "comportamiento seguro ante actualización"). `registerType: 'prompt'`
 * (vite.config.ts) hace que Workbox NUNCA reemplace la app en uso sin avisar --
 * este componente es el aviso: la empleada decide cuándo actualizar, nunca se le
 * corta una carga en curso porque el service worker se actualizó solo.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('No se pudo registrar el service worker', error);
    },
  });

  if (offlineReady) {
    return (
      <div className="update-banner" role="status">
        <span>La app ya está lista para usarse sin conexión.</span>
        <button type="button" onClick={() => setOfflineReady(false)}>
          OK
        </button>
      </div>
    );
  }

  if (needRefresh) {
    return (
      <div className="update-banner" role="status">
        <span>Hay una versión nueva disponible.</span>
        <button type="button" onClick={() => void updateServiceWorker(true)}>
          Actualizar ahora
        </button>
        <button type="button" onClick={() => setNeedRefresh(false)}>
          Más tarde
        </button>
      </div>
    );
  }

  return null;
}
