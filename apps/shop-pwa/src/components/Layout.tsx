import { Outlet } from 'react-router-dom';
import { useAuth } from '@sistema-grido/auth-client';
import { UpdatePrompt } from './UpdatePrompt.js';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrador',
  DEPOSIT_MANAGER: 'Encargado de depósito',
  SHOP_EMPLOYEE: 'Empleada de heladería',
};

/** Layout mobile-first: header compacto + contenido a pantalla completa. */
export function Layout() {
  const { user, signOut } = useAuth();

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="who">
          <strong>{user?.displayName}</strong>
          <span className="muted">{user ? ROLE_LABELS[user.roleCode] : ''}</span>
        </div>
        <button type="button" className="link-button" onClick={() => void signOut()}>
          Salir
        </button>
      </header>
      <UpdatePrompt />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
