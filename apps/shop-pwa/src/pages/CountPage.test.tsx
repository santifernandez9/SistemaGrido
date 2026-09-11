import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { InventoryCount, Product, UserProfile } from '@sistema-grido/shared-types';
import { IDBFactory } from 'fake-indexeddb';

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
  ApiClientError: class ApiClientError extends Error {
    constructor(
      message: string,
      public code = 'ERROR',
      public status = 500,
    ) {
      super(message);
    }
  },
}));

const { CountPage } = await import('./CountPage.js');

const PRODUCTS: Product[] = [
  {
    id: 'prod-closed',
    organizationId: 'org1',
    code: 'CUCU12',
    name: 'Cucuruchos caja x12',
    categoryId: 'cat1',
    categoryName: 'Insumos',
    productTypeId: 'pt1',
    productTypeName: 'Insumo',
    unitOfMeasureId: 'uom-caja',
    unitOfMeasureName: 'Caja',
    unitsPerHandlingUnit: 12,
    flavorId: null,
    flavorName: null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
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
  },
];

function renderCountPage() {
  return render(
    <MemoryRouter initialEntries={['/conteo']}>
      <CountPage />
    </MemoryRouter>,
  );
}

describe('CountPage (shop-pwa)', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    apiGet.mockReset();
    apiPost.mockReset();
    apiGet.mockResolvedValue(PRODUCTS);
  });

  it('conteo ciego: nunca muestra el stock teórico ni la diferencia mientras se cuenta', async () => {
    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    expect(screen.queryByText(/teórico/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/diferencia/i)).not.toBeInTheDocument();
  });

  it('la fracción estimada sólo se pide para un sabor con unidades abiertas, nunca para un producto cerrado', async () => {
    const user = userEvent.setup();
    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');

    const closedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(closedRow).getByLabelText(/sueltos/i), '3');
    expect(within(closedRow).queryByText(/fracción/i)).not.toBeInTheDocument();

    const flavorRow = screen.getByText('Limón lata').closest('li')!;
    await user.type(within(flavorRow).getByLabelText(/sueltos/i), '1');
    expect(within(flavorRow).getByText(/fracción/i)).toBeInTheDocument();
  });

  it('envía closedUnits/openUnits tal cual los tipeó la empleada -- nunca multiplicados en el cliente', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      id: 'count1',
      status: 'COMPLETED',
      items: [],
    } satisfies Partial<InventoryCount>);

    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    const closedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(closedRow).getByLabelText(/cerrados/i), '2');
    await user.type(within(closedRow).getByLabelText(/sueltos/i), '5');

    await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [, body] = apiPost.mock.calls[0] as [string, { items: unknown[] }];
    expect(body.items).toEqual([{ productId: 'prod-closed', closedUnits: 2, openUnits: 5 }]);
  });

  it('autoguardado: lo tipeado se persiste solo, y sobrevive a un reload simulado (remount)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    const closedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(closedRow).getByLabelText(/cerrados/i), '7');

    // Espera a que el efecto de autoguardado corra antes de "recargar".
    await waitFor(async () => {
      const { loadCountDraft, countDraftId } = await import('../lib/countDraftStore.js');
      const draft = await loadCountDraft(countDraftId('loc1', draft_weekStart()));
      expect(draft?.items['prod-closed']?.closedUnits).toBe(7);
    });

    unmount();

    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    const reloadedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    expect(within(reloadedRow).getByLabelText(/cerrados/i)).toHaveValue(7);
  });

  it('si el envío falla (corte de red), el borrador NO se borra y el reintento usa la MISMA idempotencyKey', async () => {
    const user = userEvent.setup();
    apiPost.mockRejectedValueOnce(new Error('network down'));
    apiPost.mockResolvedValueOnce({ id: 'count1', status: 'COMPLETED', items: [] });

    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    const closedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(closedRow).getByLabelText(/cerrados/i), '4');

    await user.click(screen.getByRole('button', { name: /enviar conteo/i }));
    await screen.findByText(/no se pudo enviar el conteo/i);

    await user.click(screen.getByRole('button', { name: /enviar conteo/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));

    const firstKey = (apiPost.mock.calls[0]![1] as { idempotencyKey: string }).idempotencyKey;
    const secondKey = (apiPost.mock.calls[1]![1] as { idempotencyKey: string }).idempotencyKey;
    expect(firstKey).toBe(secondKey);
  });

  it('conteo COMPLETED sin diferencias grandes: borra el borrador y muestra la confirmación', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ id: 'count1', status: 'COMPLETED', items: [] });

    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    const closedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(closedRow).getByLabelText(/cerrados/i), '1');
    await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

    await screen.findByText('Conteo enviado');

    const { loadCountDraft, countDraftId } = await import('../lib/countDraftStore.js');
    const draft = await loadCountDraft(countDraftId('loc1', draft_weekStart()));
    expect(draft).toBeNull();
  });

  it('conteo RECOUNT_REQUIRED: pasa a la pantalla de reconteo mostrando sólo los productos marcados', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValueOnce({
      id: 'count1',
      status: 'RECOUNT_REQUIRED',
      items: [
        {
          id: 'item1',
          productId: 'prod-closed',
          productName: 'Cucuruchos caja x12',
          productCode: 'CUCU12',
          closedUnits: 1,
          openUnits: null,
          openFraction: null,
          physicalQuantity: '12.000',
          theoreticalQuantity: '500.000',
          difference: '-488.000',
          needsRecount: true,
          recounted: false,
          differenceResolution: null,
          differenceResolvedById: null,
          differenceResolvedByName: null,
          differenceResolvedAt: null,
          differenceResolutionNote: null,
        },
        {
          id: 'item2',
          productId: 'prod-flavor',
          productName: 'Limón lata',
          productCode: null,
          closedUnits: 1,
          openUnits: null,
          openFraction: null,
          physicalQuantity: '1.000',
          theoreticalQuantity: '1.000',
          difference: '0.000',
          needsRecount: false,
          recounted: false,
          differenceResolution: null,
          differenceResolvedById: null,
          differenceResolvedByName: null,
          differenceResolvedAt: null,
          differenceResolutionNote: null,
        },
      ],
    } satisfies Partial<InventoryCount>);
    apiPost.mockResolvedValueOnce(undefined); // respuesta del reconteo

    renderCountPage();
    await screen.findByText('Cucuruchos caja x12');
    const closedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(closedRow).getByLabelText(/cerrados/i), '1');
    await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

    await screen.findByText('Reconteo');
    // Sólo aparece el producto marcado -- el que no necesitaba reconteo no se pide de nuevo.
    expect(screen.getByText('Cucuruchos caja x12')).toBeInTheDocument();
    expect(screen.queryByText('Limón lata')).not.toBeInTheDocument();

    const recountRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
    await user.type(within(recountRow).getByLabelText(/cerrados/i), '40');
    await user.click(screen.getByRole('button', { name: /enviar reconteo/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost.mock.calls[1]![0]).toBe('/api/shop/counts/count1/recount');
    await screen.findByText('Conteo enviado');
  });
});

function draft_weekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  const yyyy = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
