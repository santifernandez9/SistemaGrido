import { useAuth } from '@sistema-grido/auth-client';

/**
 * Pantalla inicial neutra (sección 12 del prompt de Etapa 1): confirma que la
 * sesión funciona de punta a punta. Los módulos operativos (dashboard real con
 * excepciones de stock, etc. -- RF-060) son de etapas futuras.
 */
export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="dashboard-page">
      <h1>Hola, {user?.displayName}</h1>
      <p className="muted">
        Sesión iniciada como <strong>{user?.roleCode}</strong>. Esta es la base de Etapa 1: todavía
        no hay módulos operativos (stock, ventas, cierres, etc.) — esos llegan en las próximas
        etapas.
      </p>
    </div>
  );
}
