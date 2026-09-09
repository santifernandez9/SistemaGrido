import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Product, StockoutEvent, UserProfile } from '@sistema-grido/shared-types';

const apiGet = vi.fn();
const apiPost = vi.fn();
const mockApi = { get: apiGet, post: apiPost, patch: vi.fn() };

const mockUser: UserProfile = {
  id: 'u1',
  organizationId: 'org1',
  roleCode: 'SHOP_EMPLOYEE',
  defaultLocationId: 'loc1',
  defaultLocationName: 'Heladería Centro',
  displayName: 'Flavia',
  email: 'flavia@test.com',
  active: true,
  createdAt: new Date().toISOString(),
};

vi.mock('@sistema-grido/auth-client', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: mockUser,
    loading: false,
    error: null,
    api: mockApi,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
  RequireAuth: ({ children }: { children: ReactNode }) => <>{children}</>,
  ApiClientError: class ApiClientError extends Error {},
}));

const { StockoutPage } = await import('./StockoutPage.js');

const PRODUCT: Product = {
  id: 'prod-flavor',
  organizationId: 'org1',
  code: null,
  name: 'Limón lata',
  categoryId: 'cat1',
  categoryName: 'Sabores',
  productTypeId: 'pt2',
  productTypeName: 'Helado',
  unitOfMeasureId: 'uom-lata',
  unitOfMeasureName: 'Lata',
  unitsPerHandlingUnit: 1,
  flavorId: 'flavor1',
  flavorName: 'Limón',
  active: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderPage() {
  return render(
    <MemoryRouter>
      <StockoutPage />
    </MemoryRouter>,
  );
}

describe('StockoutPage (shop-pwa)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiGet.mockResolvedValue([PRODUCT]);
  });

  it('marca sin stock y muestra la clasificación devuelta por el backend', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      id: 'ev1',
      productName: 'Limón lata',
      classification: 'URGENT_RESTOCK',
    } satisfies Partial<StockoutEvent>);

    renderPage();
    await screen.findByText('Limón lata');
    await user.click(screen.getByRole('button', { name: /marcar sin stock/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/shop/stockouts', {
      locationId: 'loc1',
      productId: 'prod-flavor',
      idempotencyKey: expect.any(String),
    });
    expect(await screen.findByText('Reposición urgente posible')).toBeInTheDocument();
  });

  it('no rompe si no hay clasificación disponible (sin depósito configurado)', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ id: 'ev1', productName: 'Limón lata', classification: null });

    renderPage();
    await screen.findByText('Limón lata');
    await user.click(screen.getByRole('button', { name: /marcar sin stock/i }));

    await screen.findByText('Marcado sin stock');
    expect(screen.queryByText(/reposición|faltante/i)).not.toBeInTheDocument();
  });
});
