import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { UserProfile } from '@sistema-grido/shared-types';

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
  RequireAuth: ({ children }: { children: ReactNode }) => {
    if (mockUser === undefined) return <div>Cargando...</div>;
    if (!mockUser) return <div data-testid="redirected-to-login">Login</div>;
    return <>{children}</>;
  },
  ApiClientError: class ApiClientError extends Error {},
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  }),
}));

const { App } = await import('./App.js');

describe('App (shop-pwa) — routing base', () => {
  it('redirige a login cuando no hay sesión', () => {
    mockUser = null;
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('redirected-to-login')).toBeInTheDocument();
  });

  it('logueada, muestra la pantalla de inicio neutra con su nombre', () => {
    mockUser = {
      id: 'u1',
      organizationId: 'org1',
      roleCode: 'SHOP_EMPLOYEE',
      defaultLocationId: 'loc1',
      displayName: 'Flavia',
      email: 'flavia@test.com',
      active: true,
      createdAt: new Date().toISOString(),
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/Flavia/).length).toBeGreaterThan(0);
    expect(screen.getByText('Empleada de heladería')).toBeInTheDocument();
  });
});
