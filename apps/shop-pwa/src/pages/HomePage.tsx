import { useAuth } from '@sistema-grido/auth-client';

/**
 * Pantalla inicial neutra (sección 12 del prompt de Etapa 1). Las pantallas
 * operativas reales de esta app (conteo, mermas, baja de lata, gasto, sin stock)
 * son de Etapa 4 -- acá sólo se confirma que la sesión funciona de punta a punta.
 */
export function HomePage() {
  const { user } = useAuth();

  return (
    <div className="home-page">
      <h1>Hola, {user?.displayName}</h1>
      <p className="muted">
        Todavía no hay pantallas operativas cargadas acá (conteo, mermas, bajas de lata, etc.) —
        esta es la base de Etapa 1. Las pantallas de trabajo llegan en la Etapa 4, calcadas de la
        planilla de papel real.
      </p>
    </div>
  );
}
