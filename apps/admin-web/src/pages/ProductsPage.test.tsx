import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Category,
  Flavor,
  Product,
  ProductType,
  UnitOfMeasure,
} from '@sistema-grido/shared-types';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();

vi.mock('@sistema-grido/auth-client', () => ({
  useAuth: () => ({ api: { get, post, patch } }),
  ApiClientError: class ApiClientError extends Error {},
}));

const { ProductsPage } = await import('./ProductsPage.js');

const categories: Category[] = [
  {
    id: 'cat1',
    organizationId: 'org1',
    parentCategoryId: null,
    name: 'Sabores al agua',
    active: true,
    createdAt: '2026-01-01',
  },
];
const productTypes: ProductType[] = [{ id: 'pt1', code: 'HELADO', name: 'Helado', active: true }];
const unitsOfMeasure: UnitOfMeasure[] = [{ id: 'uom1', code: 'LATA', name: 'Lata', active: true }];
const flavors: Flavor[] = [
  { id: 'fl1', organizationId: 'org1', name: 'Limón', active: true, createdAt: '2026-01-01' },
];

function mockCatalogGets(products: Product[]) {
  get.mockImplementation((url: string) => {
    if (url === '/api/products') return Promise.resolve(products);
    if (url === '/api/categories') return Promise.resolve(categories);
    if (url === '/api/product-types') return Promise.resolve(productTypes);
    if (url === '/api/units-of-measure') return Promise.resolve(unitsOfMeasure);
    if (url === '/api/flavors') return Promise.resolve(flavors);
    throw new Error(`GET inesperado: ${url}`);
  });
}

describe('ProductsPage', () => {
  it('muestra el catálogo cargado con sus datos relacionados', async () => {
    mockCatalogGets([
      {
        id: 'p1',
        organizationId: 'org1',
        code: 'P001',
        name: 'Limón',
        categoryId: 'cat1',
        categoryName: 'Sabores al agua',
        productTypeId: 'pt1',
        productTypeName: 'Helado',
        unitOfMeasureId: 'uom1',
        unitOfMeasureName: 'Lata',
        unitsPerHandlingUnit: 1,
        flavorId: 'fl1',
        flavorName: 'Limón',
        active: true,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    ]);

    render(<ProductsPage />);

    await waitFor(() => expect(screen.getByText('P001')).toBeInTheDocument());
    expect(screen.getAllByText('Limón').length).toBeGreaterThan(0);
    // "Sabores al agua" aparece también en los selects del formulario y del filtro.
    expect(screen.getAllByText('Sabores al agua').length).toBeGreaterThan(0);
  });

  it('crea un producto nuevo enviando POST /api/products con la equivalencia cargada', async () => {
    mockCatalogGets([]);
    post.mockResolvedValueOnce({ id: 'p2' });

    const user = userEvent.setup();
    render(<ProductsPage />);

    await waitFor(() =>
      expect(screen.getByText('Todavía no hay productos cargados.')).toBeInTheDocument(),
    );

    await user.type(screen.getByLabelText('Nombre'), 'Cucurucho Bio x 240');
    // Los selects no se auto-completan a propósito (evita crear un producto con la
    // primera categoría/tipo/unidad de la lista sin que la persona lo haya elegido):
    // el test simula la elección real de cada uno.
    await user.selectOptions(screen.getByLabelText('Categoría'), 'cat1');
    await user.selectOptions(screen.getByLabelText('Tipo'), 'pt1');
    await user.selectOptions(screen.getByLabelText('Unidad de manejo'), 'uom1');
    await user.clear(
      screen.getByLabelText(
        'Unidades por presentación (equivalencia: cuántas unidades sueltas contiene)',
      ),
    );
    await user.type(
      screen.getByLabelText(
        'Unidades por presentación (equivalencia: cuántas unidades sueltas contiene)',
      ),
      '240',
    );
    await user.click(screen.getByRole('button', { name: 'Crear producto' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['name']).toBe('Cucurucho Bio x 240');
    expect(payload['unitsPerHandlingUnit']).toBe(240);
    expect(payload['categoryId']).toBe('cat1');
  });

  it('rechaza equivalencia inválida en el propio formulario (min=1, no se puede enviar 0 o negativo)', async () => {
    mockCatalogGets([]);

    render(<ProductsPage />);

    await waitFor(() =>
      expect(screen.getByText('Todavía no hay productos cargados.')).toBeInTheDocument(),
    );

    const input = screen.getByLabelText(
      'Unidades por presentación (equivalencia: cuántas unidades sueltas contiene)',
    ) as HTMLInputElement;
    expect(input.min).toBe('1');
    expect(input.required).toBe(true);
  });
});
