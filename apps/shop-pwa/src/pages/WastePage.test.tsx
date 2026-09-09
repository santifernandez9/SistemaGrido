import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Product, UserProfile } from '@sistema-grido/shared-types';

const apiGet = vi.fn();
const apiPost = vi.fn();
const mockApi = { get: apiGet, post: apiPost, patch: vi.fn() };
const uploadAttachment = vi.fn();

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

vi.mock('../lib/uploadAttachment.js', () => ({ uploadAttachment }));

const { WastePage } = await import('./WastePage.js');

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

function renderPage() {
  return render(
    <MemoryRouter>
      <WastePage />
    </MemoryRouter>,
  );
}

describe('WastePage (shop-pwa)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    uploadAttachment.mockReset();
    apiGet.mockResolvedValue([FLAVOR]);
  });

  it('exige foto antes de enviar', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Limón lata');
    await user.type(screen.getByLabelText(/motivo/i), 'Se cayó');
    await user.click(screen.getByRole('button', { name: /registrar merma/i }));

    expect(await screen.findByText('Sacá o elegí una foto de la merma.')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('sube la foto y crea la merma con cantidad exacta', async () => {
    const user = userEvent.setup();
    uploadAttachment.mockResolvedValue('org1/WASTE_PHOTO/foto.jpg');
    apiPost.mockResolvedValue({ id: 'waste1' });

    renderPage();
    await screen.findByText('Limón lata');
    await user.type(screen.getByLabelText(/motivo/i), 'Se cayó al piso');
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/foto/i), file);

    await user.click(screen.getByRole('button', { name: /registrar merma/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(uploadAttachment).toHaveBeenCalledWith(mockApi, 'WASTE_PHOTO', file);
    expect(apiPost).toHaveBeenCalledWith('/api/shop/waste', {
      locationId: 'loc1',
      productId: 'prod-flavor',
      reason: 'Se cayó al piso',
      photoPath: 'org1/WASTE_PHOTO/foto.jpg',
      idempotencyKey: expect.any(String),
      enteredQuantity: '1',
    });
  });

  it('permite elegir fracción de lata abierta para un sabor', async () => {
    const user = userEvent.setup();
    uploadAttachment.mockResolvedValue('org1/WASTE_PHOTO/foto.jpg');
    apiPost.mockResolvedValue({ id: 'waste1' });

    renderPage();
    await screen.findByText('Limón lata');
    await user.click(screen.getByLabelText(/fracción de lata abierta/i));
    await user.type(screen.getByLabelText(/motivo/i), 'Se derritió');
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/foto/i), file);
    await user.click(screen.getByRole('button', { name: /registrar merma/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.fraction).toBe('HALF');
    expect(body.enteredQuantity).toBeUndefined();
  });
});
