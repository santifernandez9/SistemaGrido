import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const updatePassword = vi.fn();
const signOut = vi.fn();
const apiPost = vi.fn();
const apiGet = vi.fn();
let mockLoading = false;
let mockPasswordRecovery = true;

vi.mock('@sistema-grido/auth-client', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: null,
    loading: mockLoading,
    error: null,
    passwordRecovery: mockPasswordRecovery,
    updatePassword,
    signOut,
    api: { post: apiPost, get: apiGet },
  }),
  RequireAuth: ({ children }: { children: ReactNode }) => <>{children}</>,
  ApiClientError: class ApiClientError extends Error {},
}));

const { ResetPasswordPage } = await import('./ResetPasswordPage.js');

function renderPage() {
  return render(
    <MemoryRouter>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    updatePassword.mockReset();
    signOut.mockReset();
    apiPost.mockReset();
    apiGet.mockReset();
    mockLoading = false;
    mockPasswordRecovery = true;
  });

  it('C) los campos son obligatorios (validación HTML required, primera barrera)', () => {
    renderPage();
    expect(screen.getByLabelText('Nueva contraseña')).toBeRequired();
    expect(screen.getByLabelText('Confirmar nueva contraseña')).toBeRequired();
  });

  it('C) rechaza campos vacíos sin llamar a updatePassword (validación JS, segunda barrera)', () => {
    renderPage();

    // fireEvent.submit despacha el evento de submit directamente, sin pasar
    // por la validación nativa `required` del navegador (que un click en el
    // botón sí respeta) -- así se ejercita la validación propia del
    // componente como defensa en profundidad, no sólo el atributo HTML.
    const form = screen.getByRole('button', { name: /guardar nueva contraseña/i }).closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(screen.getByRole('alert')).toHaveTextContent(/completá los dos campos/i);
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('C) rechaza contraseñas que no coinciden sin llamar a updatePassword', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Nueva contraseña'), 'contrasenaSegura1');
    await user.type(screen.getByLabelText('Confirmar nueva contraseña'), 'otraContrasena2');
    await user.click(screen.getByRole('button', { name: /guardar nueva contraseña/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no coinciden/i);
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('C) invoca updatePassword con la contraseña nueva y muestra éxito', async () => {
    updatePassword.mockResolvedValueOnce(undefined);
    signOut.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Nueva contraseña'), 'contrasenaSegura1');
    await user.type(screen.getByLabelText('Confirmar nueva contraseña'), 'contrasenaSegura1');
    await user.click(screen.getByRole('button', { name: /guardar nueva contraseña/i }));

    expect(updatePassword).toHaveBeenCalledWith('contrasenaSegura1');
    expect(await screen.findByText(/actualizada correctamente/i)).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('D) si Supabase falla al actualizar, muestra un mensaje seguro sin exponer detalles del error', async () => {
    updatePassword.mockRejectedValueOnce(new Error('invalid_grant: refresh_token xyz789secret'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Nueva contraseña'), 'contrasenaSegura1');
    await user.type(screen.getByLabelText('Confirmar nueva contraseña'), 'contrasenaSegura1');
    await user.click(screen.getByRole('button', { name: /guardar nueva contraseña/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no pudimos actualizar tu contraseña/i);
    expect(alert.textContent).not.toMatch(/xyz789secret|invalid_grant|refresh_token/i);
  });

  it('E) nunca envía la contraseña a la API propia de SistemaGrido', async () => {
    updatePassword.mockResolvedValueOnce(undefined);
    signOut.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Nueva contraseña'), 'contrasenaSegura1');
    await user.type(screen.getByLabelText('Confirmar nueva contraseña'), 'contrasenaSegura1');
    await user.click(screen.getByRole('button', { name: /guardar nueva contraseña/i }));

    await screen.findByText(/actualizada correctamente/i);
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('muestra un aviso, sin formulario, cuando no hay una sesión de recuperación válida (evita loop con /login)', () => {
    mockPasswordRecovery = false;
    renderPage();

    expect(screen.queryByLabelText('Nueva contraseña')).not.toBeInTheDocument();
    expect(screen.getByText(/no es válido o ya venció/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /volver a iniciar sesión/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});
