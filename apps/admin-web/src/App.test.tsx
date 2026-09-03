import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { UserProfile } from '@sistema-grido/shared-types';

/**
 * Se mockea @sistema-grido/auth-client completo a propósito: estos tests validan
 * el routing/composición propios de admin-web (sección 19 del prompt de Etapa 1:
 * "login; rutas protegidas; sesión"), no la lógica interna del paquete compartido.
 */
let mockUser: UserProfile | null | undefined = null;

vi.mock('@sistema-grido/auth-client', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: mockUser,
    loading: mockUser === undefined,
    error: null,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
  RequireAuth: ({ children, roles }: { children: ReactNode; roles?: string[] }) => {
    if (mockUser === undefined) return <div>Cargando...</div>;
    if (!mockUser) return <div data-testid="redirected-to-login">Login</div>;
    if (roles && !roles.includes(mockUser.roleCode)) return <div>No tenés acceso</div>;
    return <>{children}</>;
  },
  ApiClientError: class ApiClientError extends Error {},
}));

const { App } = await import('./App.js');

describe('App — routing base', () => {
  it('redirige a login cuando no hay sesión', () => {
    mockUser = null;
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('redirected-to-login')).toBeInTheDocument();
  });

  it('una vez logueado, muestra el layout con el nombre del usuario', () => {
    mockUser = {
      id: 'u1',
      organizationId: 'org1',
      roleCode: 'ADMIN',
      defaultLocationId: null,
      displayName: 'Ana Admin',
      email: 'ana@test.com',
      active: true,
      createdAt: new Date().toISOString(),
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/Ana Admin/).length).toBeGreaterThan(0);
  });

  it('una empleada no ve el link a Usuarios (sólo ADMIN)', () => {
    mockUser = {
      id: 'u2',
      organizationId: 'org1',
      roleCode: 'SHOP_EMPLOYEE',
      defaultLocationId: 'loc1',
      displayName: 'Empleada',
      email: 'empleada@test.com',
      active: true,
      createdAt: new Date().toISOString(),
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Usuarios')).not.toBeInTheDocument();
  });
});
