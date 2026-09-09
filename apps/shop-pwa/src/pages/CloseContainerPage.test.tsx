import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Product, UserProfile } from '@sistema-grido/shared-types';

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

const { CloseContainerPage } = await import('./CloseContainerPage.js');

const FLAVOR: Product = {
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

const NOT_FLAVOR: Product = { ...FLAVOR, id: 'prod-closed', name: 'Cucuruchos', flavorId: null };

function renderPage() {
  return render(
    <MemoryRouter>
      <CloseContainerPage />
    </MemoryRouter>,
  );
}

describe('CloseContainerPage (shop-pwa)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiGet.mockResolvedValue([FLAVOR, NOT_FLAVOR]);
  });

  it('sólo ofrece sabores de helado, no productos cerrados', async () => {
    renderPage();
    await screen.findByText('Limón lata');
    expect(screen.queryByText('Cucuruchos')).not.toBeInTheDocument();
  });

  it('confirmar da de baja en un único toque, sin pedir cantidad ni motivo', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ id: 'mov1' });
    renderPage();
    await screen.findByText('Limón lata');

    expect(screen.queryByLabelText(/cantidad/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirmar baja/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/shop/ice-cream-containers/close', {
      locationId: 'loc1',
      productId: 'prod-flavor',
      idempotencyKey: expect.any(String),
    });
    await screen.findByText('Lata dada de baja');
  });
});
