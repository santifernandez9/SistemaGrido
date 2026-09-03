import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Category } from '@sistema-grido/shared-types';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();

vi.mock('@sistema-grido/auth-client', () => ({
  useAuth: () => ({ api: { get, post, patch } }),
  ApiClientError: class ApiClientError extends Error {},
}));

const { CategoriesPage } = await import('./CategoriesPage.js');

describe('CategoriesPage', () => {
  it('muestra un grupo con su subgrupo indentado debajo', async () => {
    const categories: Category[] = [
      {
        id: 'c1',
        organizationId: 'org1',
        parentCategoryId: null,
        name: 'Bombones',
        active: true,
        createdAt: '2026-01-01',
      },
      {
        id: 'c2',
        organizationId: 'org1',
        parentCategoryId: 'c1',
        name: 'Bombón Suizo',
        active: true,
        createdAt: '2026-01-01',
      },
    ];
    get.mockResolvedValueOnce(categories);

    render(<CategoriesPage />);

    // "Bombones" aparece dos veces (la fila de la tabla y la opción del select de
    // "grupo padre" del formulario) -- se confirma que aparece, no que sea único.
    await waitFor(() => expect(screen.getAllByText('Bombones').length).toBeGreaterThan(0));
    expect(screen.getByText(/Bombón Suizo/)).toBeInTheDocument();
  });

  it('crea una categoría de primer nivel enviando POST /api/categories', async () => {
    get.mockResolvedValue([]);
    post.mockResolvedValueOnce({ id: 'c3', name: 'Postres', parentCategoryId: null });

    const user = userEvent.setup();
    render(<CategoriesPage />);

    await waitFor(() => expect(screen.getByText('No hay categorías todavía.')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Nombre'), 'Postres');
    await user.click(screen.getByRole('button', { name: 'Crear categoría' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/categories', {
        name: 'Postres',
        parentCategoryId: null,
      }),
    );
  });
});
