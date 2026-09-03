import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Flavor } from '@sistema-grido/shared-types';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();

vi.mock('@sistema-grido/auth-client', () => ({
  useAuth: () => ({ api: { get, post, patch } }),
  ApiClientError: class ApiClientError extends Error {},
}));

const { FlavorsPage } = await import('./FlavorsPage.js');

describe('FlavorsPage', () => {
  it('carga y muestra los sabores existentes', async () => {
    const flavors: Flavor[] = [
      { id: 'f1', organizationId: 'org1', name: 'Limón', active: true, createdAt: '2026-01-01' },
    ];
    get.mockResolvedValueOnce(flavors);

    render(<FlavorsPage />);

    await waitFor(() => expect(screen.getByText('Limón')).toBeInTheDocument());
    expect(screen.getByText('Activo')).toBeInTheDocument();
  });

  it('crea un sabor nuevo enviando POST /api/flavors', async () => {
    get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f2', organizationId: 'org1', name: 'Mango', active: true, createdAt: '2026-01-01' },
      ]);
    post.mockResolvedValueOnce({ id: 'f2', name: 'Mango', active: true });

    const user = userEvent.setup();
    render(<FlavorsPage />);

    await waitFor(() => expect(screen.getByText('No hay sabores todavía.')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Nombre'), 'Mango');
    await user.click(screen.getByRole('button', { name: 'Crear sabor' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/flavors', { name: 'Mango' }));
  });

  it('muestra el error del backend si la creación falla', async () => {
    get.mockResolvedValue([]);
    post.mockRejectedValueOnce(new Error('Ya existe un sabor con ese nombre'));

    const user = userEvent.setup();
    render(<FlavorsPage />);

    await waitFor(() => expect(screen.getByText('No hay sabores todavía.')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Nombre'), 'Limón');
    await user.click(screen.getByRole('button', { name: 'Crear sabor' }));

    await waitFor(() =>
      expect(screen.getByText('No se pudo guardar el sabor')).toBeInTheDocument(),
    );
  });
});
