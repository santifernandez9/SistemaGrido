import { useAuth } from '@sistema-grido/auth-client';

/**
 * Pantalla inicial neutra (Etapa 2, sección 18: "no simular funcionalidades
 * inexistentes"). Las pantallas operativas reales de esta app (conteo, mermas,
 * baja de lata, gasto, sin stock) son de una etapa futura -- acá sólo se confirma
 * que la sesión funciona de punta a punta y se ve la sucursal asignada.
 */
export function HomePage() {
  const { user } = useAuth();

  return (
    <div className="home-page">
      <h1>Hola, {user?.displayName}</h1>
      {user?.defaultLocationName && (
        <p className="location-badge">Sucursal: {user.defaultLocationName}</p>
      )}
      <p className="muted">
        Todavía no hay pantallas operativas cargadas acá (conteo, mermas, bajas de lata, etc.) —
        esta es la base de Catálogo y Maestros (Etapa 2). Las pantallas de trabajo diario llegan en
        una etapa posterior, calcadas de la planilla de papel real.
      </p>
    </div>
  );
}
