import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  GeneralWeeklyClosing,
  InventoryCount,
  LocationSummary,
  Page,
  WeeklyClosing,
  WeeklyClosingDetail,
} from '@sistema-grido/shared-types';

const get = vi.fn();
const post = vi.fn();
// Referencia ESTABLE entre renders -- WeeklyClosingDetailPanel memoiza
// `loadGoverningCount` con `useCallback(..., [api])`; si el mock de
// `useAuth` devolviera un objeto `api` nuevo en cada llamada (como un
// literal inline), esa dependencia cambiaría en cada render y dispararía
// un loop infinito de efectos (igual que pasaría con el AuthProvider real
// si no memoizara `api`, cosa que sí hace).
const api = { get, post };

vi.mock('@sistema-grido/auth-client', () => ({
  useAuth: () => ({ api }),
  ApiClientError: class ApiClientError extends Error {},
}));

const { WeeklyClosingPage } = await import('./WeeklyClosingPage.js');

const locations: LocationSummary[] = [
  { id: 'loc1', name: 'Heladería Centro', type: 'ICE_CREAM_SHOP', active: true },
];

const closingsPage: Page<WeeklyClosing> = {
  items: [
    {
      id: 'wc1',
      organizationId: 'org1',
      locationId: 'loc1',
      locationName: 'Heladería Centro',
      periodStart: '2026-10-19',
      periodEnd: '2026-10-25',
      status: 'OPEN',
      currentRevision: 0,
      reviewConfirmedById: null,
      reviewConfirmedByName: null,
      reviewConfirmedAt: null,
      createdById: 'u1',
      createdByName: 'Admin',
      createdAt: '2026-10-19',
      closedById: null,
      closedByName: null,
      closedAt: null,
      reopenedById: null,
      reopenedByName: null,
      reopenedAt: null,
      reopenReason: null,
    },
  ],
  page: 1,
  pageSize: 50,
  total: 1,
};

function baseChecklist(): WeeklyClosingDetail['checklist'] {
  return {
    countSubmitted: true,
    governingCountId: 'count1',
    governingCountWeekStart: '2026-10-26',
    governingCountStatus: 'COMPLETED',
    salesImportsTotal: 2,
    salesImportsConfirmed: 2,
    wastesTotal: 0,
    variableExpensesTotal: 0,
    reviewConfirmedById: null,
    reviewConfirmedByName: null,
    reviewConfirmedAt: null,
    missingCostProducts: [],
    pendingDifferenceResolutions: [],
    canClose: false,
  };
}

function baseDetail(
  checklistOverrides: Partial<WeeklyClosingDetail['checklist']> = {},
  items: WeeklyClosingDetail['items'] = [],
): WeeklyClosingDetail {
  return {
    closing: closingsPage.items[0]!,
    checklist: { ...baseChecklist(), ...checklistOverrides },
    revision: 0,
    items,
  };
}

function generalClosing(overrides: Partial<GeneralWeeklyClosing> = {}): GeneralWeeklyClosing {
  return {
    id: null,
    organizationId: 'org1',
    periodStart: '2026-10-19',
    periodEnd: '2026-10-25',
    status: 'OPEN',
    closedById: null,
    closedByName: null,
    closedAt: null,
    locations: [
      {
        locationId: 'loc1',
        locationName: 'Heladería Centro',
        weeklyClosingId: 'wc1',
        weeklyClosingStatus: 'OPEN',
        ready: false,
      },
    ],
    canClose: false,
    ...overrides,
  };
}

function mockMasterGets() {
  get.mockImplementation((url: string) => {
    if (url === '/api/locations') return Promise.resolve(locations);
    if (url === '/api/weekly-closings?pageSize=50') return Promise.resolve(closingsPage);
    if (url.startsWith('/api/weekly-closings/general?periodStart='))
      return Promise.resolve(generalClosing());
    throw new Error(`GET inesperado: ${url}`);
  });
}

describe('WeeklyClosingPage', () => {
  it('carga sucursales y la tabla de cierres ya preparados', async () => {
    mockMasterGets();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));
    expect(screen.getByText('2026-10-19 — 2026-10-25')).toBeInTheDocument();
    expect(screen.getAllByText('Abierto').length).toBeGreaterThan(0);
  });

  it('prepara un cierre nuevo enviando POST /api/weekly-closings con el lunes de la semana elegida', async () => {
    mockMasterGets();
    post.mockResolvedValueOnce({ id: 'wc2' } as WeeklyClosing);
    const user = userEvent.setup();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));

    const dateInput = screen.getByLabelText('Cualquier día de la semana a cerrar');
    fireEvent.change(dateInput, { target: { value: '2026-10-21' } }); // miércoles -> lunes = 2026-10-19

    await user.click(screen.getByRole('button', { name: 'Ver / preparar cierre de esta semana' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/weekly-closings', expect.any(Object)),
    );
    const [, payload] = post.mock.calls.find(([url]) => url === '/api/weekly-closings')!;
    expect(payload).toMatchObject({ locationId: 'loc1', periodStart: '2026-10-19' });
  });

  it("borrar el campo de fecha no rompe la pantalla (input date vacío transitorio -- mondayOf('') no debe explotar)", async () => {
    mockMasterGets();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));

    const dateInput = screen.getByLabelText(
      'Cualquier día de la semana a cerrar',
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-10-21' } });
    expect(dateInput.value).toBe('2026-10-21');

    // Botón "x" del navegador / borrar todo a mano -> value = ''.
    fireEvent.change(dateInput, { target: { value: '' } });

    // La pantalla sigue en pie (no crashea) y conserva la última semana válida.
    expect(
      screen.getByText('Semana: 2026-10-19 (lunes) — 2026-10-25 (domingo)'),
    ).toBeInTheDocument();
  });

  it('al elegir un cierre de la lista muestra el checklist y explica por qué todavía no se puede cerrar', async () => {
    mockMasterGets();
    get.mockImplementation((url: string) => {
      if (url === '/api/locations') return Promise.resolve(locations);
      if (url === '/api/weekly-closings?pageSize=50') return Promise.resolve(closingsPage);
      if (url.startsWith('/api/weekly-closings/general?periodStart='))
        return Promise.resolve(generalClosing());
      if (url === '/api/weekly-closings/wc1')
        return Promise.resolve(
          baseDetail({ reviewConfirmedById: null, pendingDifferenceResolutions: [] }),
        );
      throw new Error(`GET inesperado: ${url}`);
    });
    const user = userEvent.setup();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));
    await user.click(screen.getByText('2026-10-19 — 2026-10-25'));

    expect(await screen.findByText('Checklist')).toBeInTheDocument();
    expect(
      screen.getByText(/hace falta la confirmación de revisión del checklist/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar que revisé el checklist' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cerrar semana' })).toBeDisabled();
  });

  it('F) muestra "Diferencias pendientes de resolver" en el checklist y bloquea el cierre hasta resolverlas (Etapa 6.2.2, BLOCKER 2)', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/locations') return Promise.resolve(locations);
      if (url === '/api/weekly-closings?pageSize=50') return Promise.resolve(closingsPage);
      if (url.startsWith('/api/weekly-closings/general?periodStart='))
        return Promise.resolve(generalClosing());
      if (url === '/api/weekly-closings/wc1')
        return Promise.resolve(
          baseDetail({
            reviewConfirmedById: 'u1',
            reviewConfirmedByName: 'Admin',
            reviewConfirmedAt: '2026-10-26',
            pendingDifferenceResolutions: [
              {
                productId: 'p1',
                productName: 'Limón',
                difference: '-3.000',
                reason: 'SHORTAGE_NOT_CONFIRMED',
              },
            ],
          }),
        );
      throw new Error(`GET inesperado: ${url}`);
    });
    const user = userEvent.setup();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));
    await user.click(screen.getByText('2026-10-19 — 2026-10-25'));

    expect(await screen.findByText(/Hay 1 diferencia pendiente de resolver/)).toBeInTheDocument();
    expect(screen.getByText(/Limón \(-3.000\): faltante sin confirmar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar semana' })).toBeDisabled();
    expect(screen.getByText(/resolver 1 diferencia\(s\) pendiente\(s\)/)).toBeInTheDocument();
  });

  it('resuelve una diferencia (faltante confirmado) enviando POST resolve-difference del conteo gobernante', async () => {
    const governingCount: InventoryCount = {
      id: 'count1',
      organizationId: 'org1',
      locationId: 'loc1',
      locationName: 'Heladería Centro',
      weekStart: '2026-10-26',
      status: 'COMPLETED',
      submittedAt: '2026-10-26',
      recountedAt: null,
      completedAt: '2026-10-26',
      createdById: 'u2',
      createdByName: 'Empleada',
      items: [
        {
          id: 'item1',
          productId: 'p1',
          productName: 'Limón',
          productCode: null,
          closedUnits: 1,
          openUnits: 0,
          openFraction: null,
          depositoClosedUnits: null,
          presentationBreakdown: null,
          physicalQuantity: '1.000',
          theoreticalQuantity: '4.000',
          difference: '-3.000',
          needsRecount: false,
          recounted: false,
          differenceResolution: null,
          differenceResolvedById: null,
          differenceResolvedByName: null,
          differenceResolvedAt: null,
          differenceResolutionNote: null,
        },
      ],
      typoCandidates: [],
    };

    get.mockImplementation((url: string) => {
      if (url === '/api/locations') return Promise.resolve(locations);
      if (url === '/api/weekly-closings?pageSize=50') return Promise.resolve(closingsPage);
      if (url.startsWith('/api/weekly-closings/general?periodStart='))
        return Promise.resolve(generalClosing());
      if (url === '/api/weekly-closings/wc1')
        return Promise.resolve(
          baseDetail(
            {
              pendingDifferenceResolutions: [
                {
                  productId: 'p1',
                  productName: 'Limón',
                  difference: '-3.000',
                  reason: 'SHORTAGE_NOT_CONFIRMED',
                },
              ],
            },
            [
              {
                productId: 'p1',
                productName: 'Limón',
                quantityTheoretical: '4.000',
                quantityReal: '1.000',
                difference: '-3.000',
                countCorrectionMovementId: null,
                unitCostWithTax: null,
                totalValue: null,
                priceValueId: null,
              },
            ],
          ),
        );
      if (url === '/api/shop/counts/count1') return Promise.resolve(governingCount);
      throw new Error(`GET inesperado: ${url}`);
    });
    post.mockResolvedValueOnce({
      ...governingCount,
      items: [{ ...governingCount.items[0]!, differenceResolution: 'SHORTAGE_CONFIRMED' }],
    } as InventoryCount);

    const user = userEvent.setup();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));
    await user.click(screen.getByText('2026-10-19 — 2026-10-25'));

    const button = await screen.findByRole('button', { name: 'Confirmar faltante' });
    await user.click(button);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/shop/counts/count1/items/item1/resolve-difference', {
        kind: 'SHORTAGE_CONFIRMED',
      }),
    );
  });

  it('el cierre general muestra el estado por heladería y deshabilita "Cerrar semana (general)" si no todas están listas', async () => {
    mockMasterGets();
    render(<WeeklyClosingPage />);

    const generalPanel = (await screen.findByText('Cierre semanal general')).closest('section')!;
    await waitFor(() =>
      expect(within(generalPanel).getByText('Heladería Centro')).toBeInTheDocument(),
    );
    expect(within(generalPanel).getAllByText('Abierto').length).toBeGreaterThan(0);
    expect(
      within(generalPanel).getByRole('button', { name: /Cerrar semana \(general\)/ }),
    ).toBeDisabled();
  });

  it('reabrir un cierre cerrado exige un motivo antes de enviar la solicitud', async () => {
    const closedClosing: WeeklyClosing = {
      ...closingsPage.items[0]!,
      status: 'CLOSED',
      closedById: 'u1',
      closedByName: 'Admin',
      closedAt: '2026-10-26',
      currentRevision: 1,
    };
    get.mockImplementation((url: string) => {
      if (url === '/api/locations') return Promise.resolve(locations);
      if (url === '/api/weekly-closings?pageSize=50')
        return Promise.resolve({ ...closingsPage, items: [closedClosing] });
      if (url.startsWith('/api/weekly-closings/general?periodStart='))
        return Promise.resolve(generalClosing());
      if (url === '/api/weekly-closings/wc1')
        return Promise.resolve({
          closing: closedClosing,
          checklist: { ...baseChecklist(), reviewConfirmedById: 'u1', canClose: false },
          revision: 1,
          items: [],
        } as WeeklyClosingDetail);
      throw new Error(`GET inesperado: ${url}`);
    });
    const user = userEvent.setup();
    render(<WeeklyClosingPage />);

    await waitFor(() => expect(screen.getAllByText('Heladería Centro').length).toBeGreaterThan(0));
    await user.click(screen.getByText('2026-10-19 — 2026-10-25'));

    await user.click(await screen.findByRole('button', { name: 'Reabrir' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('La reapertura requiere un motivo');
    expect(post).not.toHaveBeenCalledWith('/api/weekly-closings/wc1/reopen', expect.any(Object));
  });
});
