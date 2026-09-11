import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  InventoryCount,
  Page,
  StockoutEvent,
  VariableExpense,
  Waste,
} from '@sistema-grido/shared-types';

const get = vi.fn();

vi.mock('@sistema-grido/auth-client', () => ({
  useAuth: () => ({ api: { get, post: vi.fn(), patch: vi.fn() } }),
  ApiClientError: class ApiClientError extends Error {},
}));

const { ShopOpsPage } = await import('./ShopOpsPage.js');

const COUNT_PAGE: Page<InventoryCount> = {
  items: [
    {
      id: 'count1',
      organizationId: 'org1',
      locationId: 'loc1',
      locationName: 'Heladería Centro',
      weekStart: '2026-09-07',
      status: 'RECOUNT_REQUIRED',
      submittedAt: new Date().toISOString(),
      recountedAt: null,
      completedAt: null,
      createdById: 'u1',
      createdByName: 'Flavia',
      items: [
        {
          id: 'item1',
          productId: 'p1',
          productName: 'Limón lata',
          productCode: null,
          closedUnits: 1,
          openUnits: null,
          openFraction: null,
          depositoClosedUnits: null,
          physicalQuantity: '1.000',
          theoreticalQuantity: '25.000',
          difference: '-24.000',
          needsRecount: true,
          recounted: false,
          differenceResolution: null,
          differenceResolvedById: null,
          differenceResolvedByName: null,
          differenceResolvedAt: null,
          differenceResolutionNote: null,
        },
      ],
      typoCandidates: [],
    },
  ],
  page: 1,
  pageSize: 50,
  total: 1,
};

const WASTE_LIST: Waste[] = [
  {
    id: 'waste1',
    organizationId: 'org1',
    locationId: 'loc1',
    locationName: 'Heladería Centro',
    productId: 'p1',
    productName: 'Limón lata',
    quantity: '1.000',
    reason: 'Se cayó',
    photoPath: 'org1/WASTE_PHOTO/foto.jpg',
    photoUrl: 'https://storage.test/foto.jpg',
    createdById: 'u1',
    createdByName: 'Flavia',
    occurredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  },
];

const EXPENSE_LIST: VariableExpense[] = [
  {
    id: 'exp1',
    organizationId: 'org1',
    locationId: 'loc1',
    locationName: 'Heladería Centro',
    amount: '1500.50',
    category: 'Limpieza',
    description: 'Detergente',
    receiptPath: null,
    receiptUrl: null,
    occurredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    createdById: 'u1',
    createdByName: 'Flavia',
  },
];

const STOCKOUT_LIST: StockoutEvent[] = [
  {
    id: 'ev1',
    organizationId: 'org1',
    locationId: 'loc1',
    locationName: 'Heladería Centro',
    productId: 'p1',
    productName: 'Limón lata',
    classification: 'URGENT_RESTOCK',
    occurredAt: new Date().toISOString(),
    createdById: 'u1',
    createdByName: 'Flavia',
  },
];

describe('ShopOpsPage', () => {
  beforeEach(() => {
    get.mockReset();
  });

  function mockAllEndpoints() {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/api/shop/counts')) return Promise.resolve(COUNT_PAGE);
      if (url === '/api/shop/waste') return Promise.resolve(WASTE_LIST);
      if (url === '/api/shop/expenses') return Promise.resolve(EXPENSE_LIST);
      if (url === '/api/shop/stockouts') return Promise.resolve(STOCKOUT_LIST);
      throw new Error(`endpoint no mockeado: ${url}`);
    });
  }

  it('pestaña Conteos: lista los conteos y al hacer click muestra las diferencias por producto', async () => {
    mockAllEndpoints();
    const user = userEvent.setup();
    render(<ShopOpsPage />);

    await screen.findByText('Heladería Centro');
    expect(screen.getByText('2026-09-07')).toBeInTheDocument();

    await user.click(screen.getByText('Heladería Centro'));
    expect(await screen.findByText('-24.000')).toBeInTheDocument();
  });

  it('pestaña Mermas: lista las mermas con su foto', async () => {
    mockAllEndpoints();
    const user = userEvent.setup();
    render(<ShopOpsPage />);

    await user.click(screen.getByRole('button', { name: 'Mermas' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/shop/waste'));
    expect(await screen.findByText('Se cayó')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ver foto/i })).toHaveAttribute(
      'href',
      'https://storage.test/foto.jpg',
    );
  });

  it('pestaña Gastos: lista los gastos variables', async () => {
    mockAllEndpoints();
    const user = userEvent.setup();
    render(<ShopOpsPage />);

    await user.click(screen.getByRole('button', { name: 'Gastos' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/shop/expenses'));
    expect(await screen.findByText('Detergente')).toBeInTheDocument();
    expect(screen.getByText('$1500.50')).toBeInTheDocument();
  });

  it('pestaña Sin stock: lista los eventos con su clasificación', async () => {
    mockAllEndpoints();
    const user = userEvent.setup();
    render(<ShopOpsPage />);

    await user.click(screen.getByRole('button', { name: 'Sin stock' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/shop/stockouts'));
    expect(await screen.findByText('Reposición urgente posible')).toBeInTheDocument();
  });
});
