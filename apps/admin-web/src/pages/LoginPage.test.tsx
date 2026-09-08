import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const signIn = vi.fn();
const requestPasswordReset = vi.fn();
let mockUser: unknown = null;

vi.mock('@sistema-grido/auth-client', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: mockUser,
    loading: false,
    error: null,
    signIn,
    signOut: vi.fn(),
    requestPasswordReset,
  }),
  RequireAuth: ({ children }: { children: ReactNode }) => <>{children}</>,
  ApiClientError: class ApiClientError extends Error {},
}));

const { LoginPage } = await import('./LoginPage.js');

describe('LoginPage', () => {
  it('A) pide email y contraseña y llama a signIn al enviar (login normal)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Email'), 'admin@test.com');
    await user.type(screen.getByLabelText('Contraseña'), 'password123');
    await user.click(screen.getByRole('button', { name: /ingresar/i }));

    expect(signIn).toHaveBeenCalledWith('admin@test.com', 'password123');
  });

  it('no permite enviar el formulario sin completar los campos (validación HTML required)', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Email')).toBeRequired();
    expect(screen.getByLabelText('Contraseña')).toBeRequired();
  });

  describe('B) "¿Olvidaste tu contraseña?"', () => {
    it('pide el email y llama a requestPasswordReset con redirectTo hacia /reset-password', async () => {
      requestPasswordReset.mockResolvedValueOnce(undefined);
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );

      await user.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
      await user.type(screen.getByLabelText('Email'), 'usuario@test.com');
      await user.click(screen.getByRole('button', { name: /enviar instrucciones/i }));

      expect(requestPasswordReset).toHaveBeenCalledTimes(1);
      const [email, redirectTo] = requestPasswordReset.mock.calls[0] as [string, string];
      expect(email).toBe('usuario@test.com');
      expect(redirectTo).toContain('/reset-password');
    });

    it('D) muestra un mensaje seguro y genérico incluso si Supabase devuelve un error, sin exponer detalles', async () => {
      requestPasswordReset.mockRejectedValueOnce(new Error('user_not_found: token abc123secret'));
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );

      await user.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
      await user.type(screen.getByLabelText('Email'), 'usuario@test.com');
      await user.click(screen.getByRole('button', { name: /enviar instrucciones/i }));

      const message = await screen.findByText(/si el email corresponde a una cuenta/i);
      expect(message.textContent).not.toMatch(/abc123secret|user_not_found|token/i);
    });

    it('permite volver a la pantalla de login', async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );

      await user.click(screen.getByRole('button', { name: /olvidaste tu contraseña/i }));
      expect(screen.queryByLabelText('Contraseña')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /volver a iniciar sesión/i }));
      expect(screen.getByLabelText('Contraseña')).toBeInTheDocument();
    });
  });
});
