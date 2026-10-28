import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type {
  InventoryCount,
  InventoryCountItemResult,
  Product,
  ProductCountingPresentation,
  UserProfile,
} from '@sistema-grido/shared-types';
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

// 3 categorías distintas a propósito -- incluida una ("Categoría Inventada
// XYZ") que NO existe en ningún lugar del código fuente, para probar que el
// agrupado/etiquetado es 100% dinámico (viene del catálogo, nunca de una
// lista fija).
const PRODUCT_SIMPLE: Product = {
  id: 'prod-simple',
  organizationId: 'org1',
  code: 'VASO',
  name: 'Vasito descartable',
  categoryId: 'cat-xyz',
  categoryName: 'Categoría Inventada XYZ',
  productTypeId: 'pt1',
  productTypeName: 'Insumo',
  unitOfMeasureId: 'uom-unidad',
  unitOfMeasureName: 'Unidad',
  unitsPerHandlingUnit: 1,
  flavorId: null,
  flavorName: null,
  active: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const PRODUCT_BOX: Product = {
  id: 'prod-box',
  organizationId: 'org1',
  code: 'CUCU12',
  name: 'Cucuruchos caja x12',
  categoryId: 'cat-insumos',
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
};

const PRODUCT_FLAVOR: Product = {
  id: 'prod-flavor',
  organizationId: 'org1',
  code: null,
  name: 'Limón lata',
  categoryId: 'cat-sabores',
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

const PRODUCTS: Product[] = [PRODUCT_SIMPLE, PRODUCT_BOX, PRODUCT_FLAVOR];

function renderCountPage() {
  return render(
    <MemoryRouter initialEntries={['/conteo']}>
      <CountPage />
    </MemoryRouter>,
  );
}

/** Abre (o cierra, si ya estaba abierta) la sección plegable de un rubro --
 * clickeando el `<summary>` nativo, como haría una empleada en el celular. */
async function toggleCategory(user: ReturnType<typeof userEvent.setup>, category: string) {
  await user.click(screen.getByText(category));
}

/**
 * Etapa 6.2.2, secciones 1/2/5 del prompt (BLOCKER): el botón "Enviar
 * conteo" ahora exige que TODOS los productos activos del catálogo estén
 * contados (nunca sólo el que le interesa a un test puntual). Este archivo
 * usa un catálogo fijo de 3 productos (`PRODUCTS`) -- se completan acá, en
 * un único lugar, los que un test no haya tocado explícitamente (con "0",
 * "contado explícitamente en cero"), para que cada test siga probando SÓLO
 * lo que le interesa sin repetir el resto del catálogo en cada caso.
 */
async function completeOtherProducts(
  user: ReturnType<typeof userEvent.setup>,
  excludeProductId: string,
) {
  const entries: Array<{ id: string; category: string; name: string; label: RegExp }> = [
    {
      id: 'prod-simple',
      category: 'Categoría Inventada XYZ',
      name: 'Vasito descartable',
      label: /cerrados/i,
    },
    { id: 'prod-box', category: 'Insumos', name: 'Cucuruchos caja x12', label: /cerrados/i },
    { id: 'prod-flavor', category: 'Sabores', name: 'Limón lata', label: /salón - cerrada/i },
  ];
  for (const entry of entries) {
    if (entry.id === excludeProductId) continue;
    const summary = screen.getByText(entry.category).closest('summary')!;
    const details = summary.closest('details')!;
    if (!details.open) {
      await user.click(summary);
    }
    const row = screen.getByText(entry.name).closest('li')!;
    const input = within(row).getByLabelText(entry.label) as HTMLInputElement;
    if (input.value === '') {
      await user.type(input, '0');
    }
  }
}

function baseRecountItem(overrides: Partial<InventoryCountItemResult>): InventoryCountItemResult {
  return {
    id: 'item-x',
    productId: 'unknown',
    productName: 'unknown',
    productCode: null,
    closedUnits: null,
    openUnits: null,
    openFraction: null,
    depositoClosedUnits: null,
    presentationBreakdown: null,
    physicalQuantity: '0.000',
    theoreticalQuantity: '0.000',
    difference: '0.000',
    needsRecount: false,
    recounted: false,
    differenceResolution: null,
    differenceResolvedById: null,
    differenceResolvedByName: null,
    differenceResolvedAt: null,
    differenceResolutionNote: null,
    ...overrides,
  };
}

describe('CountPage (shop-pwa)', () => {
  let activePresentations: ProductCountingPresentation[] = [];

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    apiGet.mockReset();
    apiPost.mockReset();
    activePresentations = [];
    // `/api/products` vs `/api/products/counting-presentations` (Etapa
    // 6.2.2, llamada en lote de una sola vez al cargar el conteo) --
    // distinguidos por URL para que cada test pueda configurar
    // `activePresentations` sin afectar el catálogo de productos.
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/products/counting-presentations') {
        return Promise.resolve(activePresentations);
      }
      return Promise.resolve(PRODUCTS);
    });
  });

  describe('agrupado dinámico por rubro', () => {
    it('agrupa por categoryName del catálogo -- dos productos en categorías distintas quedan bajo encabezados distintos', async () => {
      renderCountPage();
      await screen.findByText('Insumos');
      expect(screen.getByText('Sabores')).toBeInTheDocument();
    });

    it('un rubro que no existe en ningún lugar del código fuente aparece igual, sin cambios de código', async () => {
      renderCountPage();
      // "Categoría Inventada XYZ" viene únicamente del fixture de este test --
      // si esto aparece, el agrupado es 100% dinámico.
      await screen.findByText('Categoría Inventada XYZ');
    });

    it('cada rubro muestra su progreso de conteo, y ordena rubros y productos alfabéticamente', async () => {
      const user = userEvent.setup();
      const { container } = renderCountPage();
      await screen.findByText('Insumos');

      // Orden alfabético de rubros: "Categoría Inventada XYZ" < "Insumos" < "Sabores".
      const categoryNames = [...container.querySelectorAll('.count-category-summary strong')].map(
        (el) => el.textContent,
      );
      expect(categoryNames).toEqual(['Categoría Inventada XYZ', 'Insumos', 'Sabores']);

      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '1');

      // El contador de "Insumos" pasa a reflejar 1/1 contado.
      const summary = screen.getByText('Insumos').closest('summary')!;
      await waitFor(() => expect(within(summary).getByText('1/1 contados')).toBeInTheDocument());
    });
  });

  describe('presentación por producto según el catálogo (nunca por nombre)', () => {
    it('unitsPerHandlingUnit === 1 y sin sabor: sólo el campo Cerrados, sin Sueltos', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Categoría Inventada XYZ');
      await toggleCategory(user, 'Categoría Inventada XYZ');

      const row = screen.getByText('Vasito descartable').closest('li')!;
      expect(within(row).getByLabelText(/cerrados/i)).toBeInTheDocument();
      expect(within(row).queryByLabelText(/sueltos/i)).not.toBeInTheDocument();
      expect(within(row).queryByText(/salón/i)).not.toBeInTheDocument();
      expect(within(row).queryByText(/depósito/i)).not.toBeInTheDocument();
    });

    it('unitsPerHandlingUnit > 1: muestra Cerrados y Sueltos', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');

      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      expect(within(row).getByLabelText(/cerrados/i)).toBeInTheDocument();
      expect(within(row).getByLabelText(/sueltos/i)).toBeInTheDocument();
    });

    it('un sabor muestra Salón (cerrada + abierta + fracción) y Depósito; la fracción sólo aparece con abiertos > 0', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Sabores');
      await toggleCategory(user, 'Sabores');

      const row = screen.getByText('Limón lata').closest('li')!;
      expect(within(row).getByLabelText(/salón - cerrada/i)).toBeInTheDocument();
      expect(within(row).getByLabelText(/salón - abierta/i)).toBeInTheDocument();
      expect(within(row).getByLabelText(/depósito/i)).toBeInTheDocument();
      expect(within(row).queryByText(/fracción/i)).not.toBeInTheDocument();

      await user.type(within(row).getByLabelText(/salón - abierta/i), '1');
      expect(within(row).getByText(/fracción/i)).toBeInTheDocument();
    });

    it('la fracción estimada nunca se pide para un producto cerrado (no sabor), aunque tenga sueltos', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');

      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/sueltos/i), '3');
      expect(within(row).queryByText(/fracción/i)).not.toBeInTheDocument();
    });
  });

  describe('conteo ciego (RN-012)', () => {
    it('nunca muestra el stock teórico ni la diferencia mientras se cuenta', async () => {
      renderCountPage();
      await screen.findByText('Insumos');
      expect(screen.queryByText(/teórico/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/diferencia/i)).not.toBeInTheDocument();
    });

    it('tampoco muestra teórico ni diferencia en la pantalla de reconteo', async () => {
      const user = userEvent.setup();
      apiPost.mockResolvedValueOnce({
        id: 'count1',
        status: 'RECOUNT_REQUIRED',
        items: [
          baseRecountItem({
            id: 'item1',
            productId: 'prod-box',
            productName: 'Cucuruchos caja x12',
            productCode: 'CUCU12',
            closedUnits: 1,
            physicalQuantity: '12.000',
            theoreticalQuantity: '500.000',
            difference: '-488.000',
            needsRecount: true,
          }),
        ],
      } satisfies Partial<InventoryCount>);

      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '1');
      await completeOtherProducts(user, 'prod-box');
      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

      await screen.findByText('Reconteo');
      expect(screen.queryByText(/teórico/i)).not.toBeInTheDocument();
      // La pantalla SÍ explica en texto que "hubo una diferencia grande" (por
      // qué se pide recontar) -- lo que nunca debe aparecer es el VALOR
      // calculado (teórico/diferencia de la respuesta del servidor).
      expect(screen.queryByText('500.000')).not.toBeInTheDocument();
      expect(screen.queryByText('-488.000')).not.toBeInTheDocument();
      expect(screen.queryByText('12.000')).not.toBeInTheDocument();
    });
  });

  describe('envío: nunca multiplica nada en el cliente', () => {
    it('envía closedUnits/openUnits/openFraction/depositoClosedUnits tal cual los tipeó la empleada', async () => {
      const user = userEvent.setup();
      apiPost.mockResolvedValue({ id: 'count1', status: 'COMPLETED', items: [] });

      renderCountPage();
      await screen.findByText('Sabores');
      await toggleCategory(user, 'Sabores');
      const row = screen.getByText('Limón lata').closest('li')!;
      await user.type(within(row).getByLabelText(/salón - cerrada/i), '2');
      await user.type(within(row).getByLabelText(/salón - abierta/i), '3');
      await user.selectOptions(within(row).getByLabelText(/fracción/i), 'HALF');
      await user.type(within(row).getByLabelText(/depósito/i), '5');
      await completeOtherProducts(user, 'prod-flavor');

      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

      await waitFor(() => expect(apiPost).toHaveBeenCalled());
      const [, body] = apiPost.mock.calls[0] as [string, { items: unknown[] }];
      // El ítem del sabor se envía tal cual se tipeó, sin ninguna
      // multiplicación cliente-side -- los otros 2 productos del catálogo
      // fijo de este archivo van completados en 0 (ver `completeOtherProducts`)
      // para satisfacer la regla de completitud, sin ser el foco del test.
      expect(body.items).toContainEqual({
        productId: 'prod-flavor',
        closedUnits: 2,
        openUnits: 3,
        openFraction: 'HALF',
        depositoClosedUnits: 5,
      });
      expect(body.items).toHaveLength(3);
    });

    it('un sabor con SOLO depositoClosedUnits cargado (nada en Salón) igual se puede enviar', async () => {
      const user = userEvent.setup();
      apiPost.mockResolvedValue({ id: 'count1', status: 'COMPLETED', items: [] });

      renderCountPage();
      await screen.findByText('Sabores');
      await toggleCategory(user, 'Sabores');
      const row = screen.getByText('Limón lata').closest('li')!;
      await user.type(within(row).getByLabelText(/depósito/i), '4');
      await completeOtherProducts(user, 'prod-flavor');

      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

      await waitFor(() => expect(apiPost).toHaveBeenCalled());
      const [, body] = apiPost.mock.calls[0] as [string, { items: unknown[] }];
      expect(body.items).toContainEqual({ productId: 'prod-flavor', depositoClosedUnits: 4 });
    });
  });

  describe('autoguardado e idempotencia', () => {
    it('lo tipeado se persiste solo, y sobrevive a un reload simulado (remount)', async () => {
      const user = userEvent.setup();
      const { unmount } = renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '7');

      // Espera a que el efecto de autoguardado corra antes de "recargar".
      await waitFor(async () => {
        const { loadCountDraft, countDraftId } = await import('../lib/countDraftStore.js');
        const draft = await loadCountDraft(countDraftId('loc1', draft_weekStart()));
        expect(draft?.items['prod-box']?.closedUnits).toBe(7);
      });

      unmount();

      const user2 = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user2, 'Insumos');
      const reloadedRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
      expect(within(reloadedRow).getByLabelText(/cerrados/i)).toHaveValue(7);
    });

    it('cambiar de sección (plegar/desplegar otro rubro) nunca pierde lo ya tipeado en la primera', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');

      await toggleCategory(user, 'Insumos'); // abre
      const boxRow = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(boxRow).getByLabelText(/cerrados/i), '2');
      await toggleCategory(user, 'Insumos'); // pliega de nuevo

      await toggleCategory(user, 'Sabores'); // abre otro rubro
      const flavorRow = screen.getByText('Limón lata').closest('li')!;
      await user.type(within(flavorRow).getByLabelText(/salón - cerrada/i), '4');

      await toggleCategory(user, 'Insumos'); // vuelve a desplegar el primero
      const boxRowAgain = screen.getByText('Cucuruchos caja x12').closest('li')!;
      expect(within(boxRowAgain).getByLabelText(/cerrados/i)).toHaveValue(2);
    });

    it('si el envío falla (corte de red), el borrador NO se borra y el reintento usa la MISMA idempotencyKey', async () => {
      const user = userEvent.setup();
      apiPost.mockRejectedValueOnce(new Error('network down'));
      apiPost.mockResolvedValueOnce({ id: 'count1', status: 'COMPLETED', items: [] });

      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '4');
      await completeOtherProducts(user, 'prod-box');

      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));
      await screen.findByText(/no se pudo enviar el conteo/i);

      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));
      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));

      const firstKey = (apiPost.mock.calls[0]![1] as { idempotencyKey: string }).idempotencyKey;
      const secondKey = (apiPost.mock.calls[1]![1] as { idempotencyKey: string }).idempotencyKey;
      expect(firstKey).toBe(secondKey);
    });
  });

  describe('resultado del envío', () => {
    it('conteo COMPLETED sin diferencias grandes: borra el borrador y muestra la confirmación', async () => {
      const user = userEvent.setup();
      apiPost.mockResolvedValue({ id: 'count1', status: 'COMPLETED', items: [] });

      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '1');
      await completeOtherProducts(user, 'prod-box');
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
          baseRecountItem({
            id: 'item1',
            productId: 'prod-box',
            productName: 'Cucuruchos caja x12',
            productCode: 'CUCU12',
            closedUnits: 1,
            physicalQuantity: '12.000',
            theoreticalQuantity: '500.000',
            difference: '-488.000',
            needsRecount: true,
          }),
          baseRecountItem({
            id: 'item2',
            productId: 'prod-flavor',
            productName: 'Limón lata',
            closedUnits: 1,
            physicalQuantity: '1.000',
            theoreticalQuantity: '1.000',
            difference: '0.000',
            needsRecount: false,
          }),
        ],
      } satisfies Partial<InventoryCount>);
      apiPost.mockResolvedValueOnce(undefined); // respuesta del reconteo

      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '1');
      await completeOtherProducts(user, 'prod-box');
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

    it('en el reconteo, un sabor marcado también muestra los 3 campos (Salón cerrada/abierta + Depósito)', async () => {
      const user = userEvent.setup();
      apiPost.mockResolvedValueOnce({
        id: 'count1',
        status: 'RECOUNT_REQUIRED',
        items: [
          baseRecountItem({
            id: 'item1',
            productId: 'prod-flavor',
            productName: 'Limón lata',
            closedUnits: 1,
            physicalQuantity: '1.000',
            theoreticalQuantity: '50.000',
            difference: '-49.000',
            needsRecount: true,
          }),
        ],
      } satisfies Partial<InventoryCount>);

      renderCountPage();
      await screen.findByText('Sabores');
      await toggleCategory(user, 'Sabores');
      const initialRow = screen.getByText('Limón lata').closest('li')!;
      await user.type(within(initialRow).getByLabelText(/salón - cerrada/i), '1');
      await completeOtherProducts(user, 'prod-flavor');
      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

      await screen.findByText('Reconteo');
      const recountRow = screen.getByText('Limón lata').closest('li')!;
      expect(within(recountRow).getByLabelText(/salón - cerrada/i)).toBeInTheDocument();
      expect(within(recountRow).getByLabelText(/salón - abierta/i)).toBeInTheDocument();
      expect(within(recountRow).getByLabelText(/depósito/i)).toBeInTheDocument();
    });
  });

  describe('completitud obligatoria del conteo (Etapa 6.2.2, secciones 1-6)', () => {
    it('muestra el progreso real X/Y y el botón queda deshabilitado mientras falten productos', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');

      expect(screen.getByText('0 de 3 productos contados.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /enviar conteo/i })).toBeDisabled();

      await toggleCategory(user, 'Insumos');
      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText(/cerrados/i), '1');

      await waitFor(() =>
        expect(screen.getByText('1 de 3 productos contados.')).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: /enviar conteo/i })).toBeDisabled();
    });

    it('un campo dejado VACÍO nunca cuenta como cero -- sólo un "0" tipeado explícitamente cuenta', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');

      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      const input = within(row).getByLabelText(/cerrados/i);
      // Foco + blur sin tipear nada -- el campo sigue vacío.
      await user.click(input);
      await user.tab();
      expect(screen.getByText('0 de 3 productos contados.')).toBeInTheDocument();

      await user.type(input, '0');
      await waitFor(() =>
        expect(screen.getByText('1 de 3 productos contados.')).toBeInTheDocument(),
      );
    });

    it('lista los rubros con productos pendientes y saltar a uno los despliega', async () => {
      const user = userEvent.setup();
      const { container } = renderCountPage();
      await screen.findByText('Insumos');

      // Ningún rubro está desplegado todavía -- el resumen de pendientes
      // permite saltar a uno sin tener que buscarlo manualmente.
      const jumpButton = screen.getByRole('button', { name: /Insumos \(1\)/ });
      const detailsBefore = container.querySelector('details.count-category');
      expect(detailsBefore).not.toHaveAttribute('open');

      await user.click(jumpButton);
      const insumosDetails = screen.getByText('Insumos').closest('details')!;
      expect(insumosDetails).toHaveAttribute('open');
    });

    it('al completar TODOS los productos, el resumen de pendientes desaparece y el botón se habilita', async () => {
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');

      await toggleCategory(user, 'Categoría Inventada XYZ');
      await user.type(
        within(screen.getByText('Vasito descartable').closest('li')!).getByLabelText(/cerrados/i),
        '0',
      );
      await toggleCategory(user, 'Insumos');
      await user.type(
        within(screen.getByText('Cucuruchos caja x12').closest('li')!).getByLabelText(/cerrados/i),
        '2',
      );
      await toggleCategory(user, 'Sabores');
      await user.type(
        within(screen.getByText('Limón lata').closest('li')!).getByLabelText(/salón - cerrada/i),
        '3',
      );

      await waitFor(() =>
        expect(screen.getByText('3 de 3 productos contados.')).toBeInTheDocument(),
      );
      expect(screen.queryByText(/Faltan \d+ producto/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /enviar conteo/i })).toBeEnabled();
    });
  });

  describe('presentaciones dinámicas por producto (Etapa 6.2.2, secciones 14-18)', () => {
    it('un producto con presentaciones activas muestra campos dinámicos por presentación, sin nombres hardcodeados, en vez de "Cerrados"', async () => {
      activePresentations = [
        {
          id: 'pres-caja',
          organizationId: 'org1',
          productId: 'prod-box',
          productName: 'Cucuruchos caja x12',
          unitOfMeasureId: 'uom-caja',
          unitOfMeasureName: 'Caja',
          conversionFactorToCanonical: '12.000',
          active: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'pres-pallet',
          organizationId: 'org1',
          productId: 'prod-box',
          productName: 'Cucuruchos caja x12',
          // Nombre deliberadamente NO estándar -- prueba que no hay ningún
          // hardcodeo de "Unidad/Caja/Pack" en la pantalla.
          unitOfMeasureId: 'uom-pallet',
          unitOfMeasureName: 'Pallet',
          conversionFactorToCanonical: '144.000',
          active: true,
          createdAt: new Date().toISOString(),
        },
      ];
      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');

      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      expect(within(row).queryByLabelText(/^cerrados/i)).not.toBeInTheDocument();
      expect(within(row).getByLabelText('Caja')).toBeInTheDocument();
      expect(within(row).getByLabelText('Pallet')).toBeInTheDocument();
    });

    it('envía `presentations` (nunca `closedUnits`) para un producto con presentaciones, sin multiplicar nada en el cliente', async () => {
      activePresentations = [
        {
          id: 'pres-caja',
          organizationId: 'org1',
          productId: 'prod-box',
          productName: 'Cucuruchos caja x12',
          unitOfMeasureId: 'uom-caja',
          unitOfMeasureName: 'Caja',
          conversionFactorToCanonical: '12.000',
          active: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'pres-pack',
          organizationId: 'org1',
          productId: 'prod-box',
          productName: 'Cucuruchos caja x12',
          unitOfMeasureId: 'uom-pack',
          unitOfMeasureName: 'Pack',
          conversionFactorToCanonical: '6.000',
          active: true,
          createdAt: new Date().toISOString(),
        },
      ];
      apiPost.mockResolvedValue({ id: 'count1', status: 'COMPLETED', items: [] });

      const user = userEvent.setup();
      renderCountPage();
      await screen.findByText('Insumos');
      await toggleCategory(user, 'Insumos');

      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      await user.type(within(row).getByLabelText('Caja'), '2');
      await user.type(within(row).getByLabelText('Pack'), '1');
      await completeOtherProducts(user, 'prod-box');

      await user.click(screen.getByRole('button', { name: /enviar conteo/i }));

      await waitFor(() => expect(apiPost).toHaveBeenCalled());
      const [, body] = apiPost.mock.calls[0] as [string, { items: Array<Record<string, unknown>> }];
      const boxItem = body.items.find((i) => i.productId === 'prod-box')!;
      expect(boxItem.closedUnits).toBeUndefined();
      expect(boxItem.presentations).toEqual([
        { presentationId: 'pres-caja', quantity: 2 },
        { presentationId: 'pres-pack', quantity: 1 },
      ]);
    });

    it('un producto sin presentaciones sigue mostrando "Cerrados" tal cual antes (compatibilidad total)', async () => {
      renderCountPage();
      await screen.findByText('Insumos');
      const user = userEvent.setup();
      await toggleCategory(user, 'Insumos');

      const row = screen.getByText('Cucuruchos caja x12').closest('li')!;
      expect(within(row).getByLabelText(/cerrados/i)).toBeInTheDocument();
    });
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
