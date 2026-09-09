import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { UserProfile } from '@sistema-grido/shared-types';

const apiPost = vi.fn();
const mockApi = { get: vi.fn(), post: apiPost, patch: vi.fn() };
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

const { ExpensePage } = await import('./ExpensePage.js');

function renderPage() {
  return render(
    <MemoryRouter>
      <ExpensePage />
    </MemoryRouter>,
  );
}

describe('ExpensePage (shop-pwa)', () => {
  beforeEach(() => {
    apiPost.mockReset();
    uploadAttachment.mockReset();
  });

  it('rechaza un monto con formato inválido antes de llamar a la API', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/monto/i), 'abc');
    await user.type(screen.getByLabelText(/categoría/i), 'Limpieza');
    await user.type(screen.getByLabelText(/descripción/i), 'Detergente');
    await user.click(screen.getByRole('button', { name: /registrar gasto/i }));

    expect(await screen.findByText(/monto inválido/i)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('crea el gasto sin comprobante (opcional) y nunca sube nada si no hay archivo', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ id: 'exp1' });
    renderPage();
    await user.type(screen.getByLabelText(/monto/i), '1500.50');
    await user.type(screen.getByLabelText(/categoría/i), 'Limpieza');
    await user.type(screen.getByLabelText(/descripción/i), 'Detergente y lavandina');
    await user.click(screen.getByRole('button', { name: /registrar gasto/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(apiPost).toHaveBeenCalledWith('/api/shop/expenses', {
      locationId: 'loc1',
      amount: '1500.50',
      category: 'Limpieza',
      description: 'Detergente y lavandina',
      receiptPath: undefined,
      idempotencyKey: expect.any(String),
    });
  });

  it('sube el comprobante cuando se adjunta uno', async () => {
    const user = userEvent.setup();
    uploadAttachment.mockResolvedValue('org1/EXPENSE_RECEIPT/recibo.jpg');
    apiPost.mockResolvedValue({ id: 'exp1' });
    renderPage();
    await user.type(screen.getByLabelText(/monto/i), '200');
    await user.type(screen.getByLabelText(/categoría/i), 'Insumos');
    await user.type(screen.getByLabelText(/descripción/i), 'Vasos');
    const file = new File(['x'], 'recibo.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/comprobante/i), file);
    await user.click(screen.getByRole('button', { name: /registrar gasto/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(uploadAttachment).toHaveBeenCalledWith(mockApi, 'EXPENSE_RECEIPT', file);
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.receiptPath).toBe('org1/EXPENSE_RECEIPT/recibo.jpg');
  });
});
