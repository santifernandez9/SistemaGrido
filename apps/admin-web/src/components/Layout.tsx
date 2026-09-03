import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '@sistema-grido/auth-client';

export function Layout() {
  const { user, signOut } = useAuth();

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="brand">SistemaGrido — Admin</div>
        <nav>
          <Link to="/">Inicio</Link>
          {user?.roleCode === 'ADMIN' && <Link to="/usuarios">Usuarios</Link>}
        </nav>
        <div className="who">
          <span>
            {user?.displayName} ({user?.roleCode})
          </span>
          <button type="button" onClick={() => void signOut()}>
            Salir
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
