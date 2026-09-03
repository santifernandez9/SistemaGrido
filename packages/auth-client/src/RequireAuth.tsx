import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { RoleCode } from '@sistema-grido/shared-types';
import { useAuth } from './AuthContext.js';

export interface RequireAuthProps {
  children: ReactNode;
  /** Si se pasa, además de estar logueado hace falta tener uno de estos roles. */
  roles?: RoleCode[];
  loginPath?: string;
  /** A dónde mandar a alguien logueado pero sin el rol necesario. */
  forbiddenFallback?: ReactNode;
}

/**
 * Ruta protegida (sección 12 del prompt de Etapa 1). Server-side esto NO reemplaza
 * la autorización real (siempre validada en el backend, sección 9) -- es sólo UX:
 * evita mostrar una pantalla que de todos modos el backend rechazaría.
 */
export function RequireAuth({
  children,
  roles,
  loginPath = '/login',
  forbiddenFallback,
}: RequireAuthProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="auth-loading">Cargando...</div>;
  }

  if (!user) {
    return <Navigate to={loginPath} state={{ from: location }} replace />;
  }

  if (roles && !roles.includes(user.roleCode)) {
    return forbiddenFallback ? (
      <>{forbiddenFallback}</>
    ) : (
      <div className="auth-forbidden">No tenés acceso a esta sección.</div>
    );
  }

  return <>{children}</>;
}
