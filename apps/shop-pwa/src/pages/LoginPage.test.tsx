import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const signIn = vi.fn();
let mockUser: unknown = null;

vi.mock('@sistema-grido/auth-client', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: mockUser, loading: false, error: null, signIn, signOut: vi.fn() }),
  RequireAuth: ({ children }: { children: ReactNode }) => <>{children}</>,
  ApiClientError: class ApiClientError extends Error {},
}));

const { LoginPage } = await import('./LoginPage.js');

describe('LoginPage (shop-pwa)', () => {
  it('pide email y contraseña y llama a signIn al enviar', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Email'), 'empleada@test.com');
    await user.type(screen.getByLabelText('Contraseña'), 'password123');
    await user.click(screen.getByRole('button', { name: /ingresar/i }));

    expect(signIn).toHaveBeenCalledWith('empleada@test.com', 'password123');
  });
});
