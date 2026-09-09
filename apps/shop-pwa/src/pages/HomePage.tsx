import { Link } from 'react-router-dom';
import { useAuth } from '@sistema-grido/auth-client';

const ACTIONS = [
  { to: '/conteo', label: 'Conteo', icon: '🧮' },
  { to: '/merma', label: 'Merma', icon: '🗑️' },
  { to: '/baja-lata', label: 'Baja de lata', icon: '🥫' },
  { to: '/gasto', label: 'Gasto', icon: '💸' },
  { to: '/sin-stock', label: 'Sin stock', icon: '⚠️' },
];

/**
 * Home operativa (Etapa 4, sección 14 del prompt): "botones grandes de
 * acceso a cada acción... sin tablas de escritorio, sin formularios
 * innecesariamente largos". Cinco capacidades, ni una más.
 */
export function HomePage() {
  const { user } = useAuth();

  return (
    <div className="home-page">
      <h1>Hola, {user?.displayName}</h1>
      {user?.defaultLocationName && (
        <p className="location-badge">Sucursal: {user.defaultLocationName}</p>
      )}
      <div className="action-grid">
        {ACTIONS.map((action) => (
          <Link key={action.to} to={action.to} className="big-button">
            <span className="big-button-icon" aria-hidden="true">
              {action.icon}
            </span>
            <span>{action.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
