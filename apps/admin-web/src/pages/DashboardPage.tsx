import { useAuth } from '@sistema-grido/auth-client';

/**
 * Pantalla inicial neutra: confirma que la sesión funciona de punta a punta. Los
 * módulos operativos (dashboard real con excepciones de stock, etc. -- RF-060) son
 * de etapas futuras; el catálogo/maestros (Etapa 2) se administra desde el menú.
 */
export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="dashboard-page">
      <h1>Hola, {user?.displayName}</h1>
      <p className="muted">
        Sesión iniciada como <strong>{user?.roleCode}</strong>. Por ahora el sistema tiene catálogo
        y maestros (Productos, Categorías, Sabores) y gestión de usuarios — todavía no hay módulos
        operativos de inventario (stock, ventas, cierres, etc.), esos llegan en etapas posteriores.
      </p>
    </div>
  );
}
