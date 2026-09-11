import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DECIMAL_QUANTITY_PATTERN,
  MONEY_AMOUNT_PATTERN,
  OPEN_CONTAINER_FRACTIONS,
  INVENTORY_COUNT_STATUSES,
  DIFFERENCE_RESOLUTION_KINDS,
} from '@sistema-grido/shared-types';
import type {
  ApiSuccess,
  CloseIceCreamContainerInput,
  CreateStockoutEventInput,
  CreateVariableExpenseInput,
  CreateWasteInput,
  InventoryCount,
  InventoryCountTypoCandidate,
  InventoryMovement,
  Page,
  ResolveInventoryDifferenceInput,
  ResolveTypoCandidateInput,
  StockoutEvent,
  SubmitInventoryCountInput,
  SubmitInventoryRecountInput,
  VariableExpense,
  Waste,
} from '@sistema-grido/shared-types';
import { requireLocationAccess, requireRole } from '../plugins/authorize.js';
import { AuthorizationError } from '../errors.js';
import { closeIceCreamContainer, createWaste, listWaste } from '../services/inventory-ledger.js';
import {
  getInventoryCountDetail,
  listInventoryCounts,
  submitInventoryCount,
  submitInventoryRecount,
} from '../services/inventory-count.js';
import {
  resolveInventoryDifference,
  resolveTypoCandidate,
} from '../services/inventory-count-resolution.js';
import { createVariableExpense, listVariableExpenses } from '../services/variable-expense.js';
import { createStockoutEvent, listStockoutEvents } from '../services/stockout.js';

/**
 * App Heladería Operativa (Etapa 4) -- ver docs/ETAPA-4-APP-HELADERIA.md.
 * Todas las rutas bajo `/api/shop`. Roles por operación, calcados de los
 * actores CONFIRMADOS por el cliente para cada RF (no una regla pareja
 * "todo el personal de heladería puede todo"):
 *
 *  - Conteo (RF-012): ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER.
 *  - Baja de lata (RF-021): ADMIN, SHOP_EMPLOYEE (el actor confirmado no
 *    incluye Encargado de depósito).
 *  - Merma (RF-024): ADMIN, SHOP_EMPLOYEE. La tabla de RF-024 sí lista
 *    también a Encargado de depósito, pero P-002 de
 *    docs/ETAPA-0-ANALISIS-ARQUITECTURA.md (P-005 en esa numeración) deja
 *    explícito que, sin confirmación, el sistema construye la restricción
 *    ya evidenciada en el prototipo actual (Encargado de depósito NO
 *    registra mermas) -- reversible sin cambio de esquema si el cliente
 *    confirma lo contrario. Ver "Permisos" en docs/ETAPA-4-APP-HELADERIA.md.
 *  - Gasto variable (RF-026): ADMIN, SHOP_EMPLOYEE.
 *  - Sin stock (RF-019): ADMIN, SHOP_EMPLOYEE.
 *
 * Ubicación: mismo patrón que apps/api/src/routes/inventory.ts
 * (`requireLocationAccess`) -- ADMIN opera sobre cualquier ubicación; el
 * resto, sólo la propia (`defaultLocationId`).
 */

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Fecha inválida');
const idParamsSchema = z.object({ id: z.string().uuid() });

const decimalQuantitySchema = z
  .string()
  .trim()
  .regex(
    DECIMAL_QUANTITY_PATTERN,
    'Cantidad inválida: debe ser un número decimal (opcionalmente negativo) con hasta 3 decimales',
  );

const moneyAmountSchema = z
  .string()
  .trim()
  .regex(MONEY_AMOUNT_PATTERN, 'Monto inválido: debe ser un número con hasta 2 decimales');

/**
 * Resuelve la ubicación efectiva para una escritura (sección 11 del prompt:
 * "un usuario sólo puede operar sobre ubicaciones permitidas"). Idéntico
 * criterio a `resolveLocationFilter` de inventory.ts pero sin admitir
 * "ninguna" (una escritura siempre necesita una ubicación concreta).
 */
async function requireWriteLocationAccess(
  request: FastifyRequest,
  locationId: string,
): Promise<void> {
  await requireLocationAccess(locationId)(request, undefined as never);
}

async function resolveLocationFilter(
  request: FastifyRequest,
  requestedLocationId: string | undefined,
): Promise<string | undefined> {
  const user = request.currentUser!;
  if (user.roleCode === 'ADMIN') {
    return requestedLocationId;
  }
  if (!user.defaultLocationId) {
    throw new AuthorizationError('Tu usuario no tiene una ubicación asignada');
  }
  const effectiveLocationId = requestedLocationId ?? user.defaultLocationId;
  await requireLocationAccess(effectiveLocationId)(request, undefined as never);
  return effectiveLocationId;
}

// --- Conteo físico semanal (RF-012/RF-020) ---------------------------------

const presentationQuantitySchema = z.object({
  presentationId: z.string().uuid(),
  quantity: z.number().int().nonnegative(),
});

const countItemSchema = z.object({
  productId: z.string().uuid(),
  closedUnits: z.number().int().nonnegative().optional(),
  openUnits: z.number().int().nonnegative().optional(),
  openFraction: z.enum(OPEN_CONTAINER_FRACTIONS).optional(),
  depositoClosedUnits: z.number().int().nonnegative().optional(),
  presentations: z.array(presentationQuantitySchema).min(1).optional(),
});

const submitCountSchema = z.object({
  locationId: z.string().uuid(),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart debe ser YYYY-MM-DD'),
  items: z.array(countItemSchema).min(1),
  idempotencyKey: z.string().min(1),
});

const submitRecountSchema = z.object({
  items: z.array(countItemSchema).min(1),
  idempotencyKey: z.string().min(1),
});

const countsQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  status: z.enum(INVENTORY_COUNT_STATUSES).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

// --- Merma (RF-024/025) -----------------------------------------------------

const createWasteSchema = z
  .object({
    locationId: z.string().uuid(),
    productId: z.string().uuid(),
    enteredQuantity: decimalQuantitySchema.optional(),
    fraction: z.enum(OPEN_CONTAINER_FRACTIONS).optional(),
    reason: z.string().min(1, 'La merma requiere un motivo'),
    photoPath: z.string().min(1, 'La merma requiere una foto'),
    occurredAt: isoDate.optional(),
    idempotencyKey: z.string().min(1),
  })
  .refine((v) => (v.enteredQuantity !== undefined) !== (v.fraction !== undefined), {
    message: 'Debe indicarse exactamente una cantidad o una fracción, no ambas ni ninguna',
  });

// --- Gasto variable (RF-026) -----------------------------------------------

const createExpenseSchema = z.object({
  locationId: z.string().uuid(),
  amount: moneyAmountSchema,
  category: z.string().min(1, 'El gasto requiere una categoría'),
  description: z.string().min(1, 'El gasto requiere una descripción'),
  receiptPath: z.string().min(1).optional(),
  occurredAt: isoDate.optional(),
  idempotencyKey: z.string().min(1),
});

// --- Sin stock (RF-019) -----------------------------------------------------

const createStockoutSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
});

// --- Baja de lata (RF-021) --------------------------------------------------

const closeContainerSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
});

const itemParamsSchema = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const candidateParamsSchema = z.object({ id: z.string().uuid(), candidateId: z.string().uuid() });

const resolveDifferenceSchema = z.object({
  kind: z.enum(DIFFERENCE_RESOLUTION_KINDS),
  note: z.string().trim().min(1).optional(),
});

const resolveTypoCandidateSchema = z.object({
  status: z.enum(['CONFIRMED', 'REJECTED']),
  note: z.string().trim().min(1).optional(),
});

export default async function shopOpsRoutes(fastify: FastifyInstance): Promise<void> {
  // --- Conteo ---------------------------------------------------------------

  fastify.post(
    '/api/shop/counts',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request, reply) => {
      const input = submitCountSchema.parse(request.body) as SubmitInventoryCountInput;
      await requireWriteLocationAccess(request, input.locationId);
      const actor = request.currentUser!;
      const created = await submitInventoryCount(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<InventoryCount> = { ok: true, data: created };
      return body;
    },
  );

  fastify.post(
    '/api/shop/counts/:id/recount',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request, reply) => {
      const params = idParamsSchema.parse(request.params);
      const input = submitRecountSchema.parse(request.body) as SubmitInventoryRecountInput;
      const actor = request.currentUser!;
      const existing = await getInventoryCountDetail(fastify, actor.organizationId, params.id);
      await requireWriteLocationAccess(request, existing.locationId);
      const updated = await submitInventoryRecount(
        fastify,
        actor.organizationId,
        actor,
        params.id,
        input,
      );
      reply.status(200);
      const body: ApiSuccess<InventoryCount> = { ok: true, data: updated };
      return body;
    },
  );

  fastify.get(
    '/api/shop/counts',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request) => {
      const query = countsQuerySchema.parse(request.query);
      const locationId = await resolveLocationFilter(request, query.locationId);
      const body: ApiSuccess<Page<InventoryCount>> = {
        ok: true,
        data: await listInventoryCounts(
          fastify,
          request.currentUser!.organizationId,
          { locationId, status: query.status },
          { page: query.page, pageSize: query.pageSize },
        ),
      };
      return body;
    },
  );

  fastify.get(
    '/api/shop/counts/:id',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const count = await getInventoryCountDetail(
        fastify,
        request.currentUser!.organizationId,
        params.id,
      );
      if (request.currentUser!.roleCode !== 'ADMIN') {
        await requireLocationAccess(count.locationId)(request, undefined as never);
      }
      const body: ApiSuccess<InventoryCount> = { ok: true, data: count };
      return body;
    },
  );

  // Etapa 6.2, secciones 4/5: resolución explícita de faltante/sobrante --
  // operación sensible de revisión, restringida a ADMIN (mismo criterio que
  // el resto de las confirmaciones/revisiones de Etapa 5/6).
  fastify.post(
    '/api/shop/counts/:id/items/:itemId/resolve-difference',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = itemParamsSchema.parse(request.params);
      const input = resolveDifferenceSchema.parse(request.body) as ResolveInventoryDifferenceInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<InventoryCount> = {
        ok: true,
        data: await resolveInventoryDifference(
          fastify,
          actor.organizationId,
          actor,
          params.id,
          params.itemId,
          input,
        ),
      };
      return body;
    },
  );

  // Etapa 6.2, sección 6: confirmar/rechazar una sugerencia de posible
  // error de tipeo -- nunca modifica Sale/InventoryMovement, sólo
  // documenta la revisión.
  fastify.post(
    '/api/shop/counts/:id/typo-candidates/:candidateId/resolve',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = candidateParamsSchema.parse(request.params);
      const input = resolveTypoCandidateSchema.parse(request.body) as ResolveTypoCandidateInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<InventoryCountTypoCandidate> = {
        ok: true,
        data: await resolveTypoCandidate(
          fastify,
          actor.organizationId,
          actor,
          params.id,
          params.candidateId,
          input,
        ),
      };
      return body;
    },
  );

  // --- Baja de lata -----------------------------------------------------

  fastify.post(
    '/api/shop/ice-cream-containers/close',
    { preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE')] },
    async (request, reply) => {
      const input = closeContainerSchema.parse(request.body) as CloseIceCreamContainerInput;
      await requireWriteLocationAccess(request, input.locationId);
      const actor = request.currentUser!;
      const created = await closeIceCreamContainer(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<InventoryMovement> = { ok: true, data: created };
      return body;
    },
  );

  // --- Merma --------------------------------------------------------------

  fastify.post(
    '/api/shop/waste',
    { preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE')] },
    async (request, reply) => {
      const input = createWasteSchema.parse(request.body) as CreateWasteInput;
      await requireWriteLocationAccess(request, input.locationId);
      const actor = request.currentUser!;
      const created = await createWaste(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<Waste> = { ok: true, data: created };
      return body;
    },
  );

  fastify.get(
    '/api/shop/waste',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request) => {
      const query = z.object({ locationId: z.string().uuid().optional() }).parse(request.query);
      const locationId = await resolveLocationFilter(request, query.locationId);
      const body: ApiSuccess<Waste[]> = {
        ok: true,
        data: await listWaste(fastify, request.currentUser!.organizationId, { locationId }),
      };
      return body;
    },
  );

  // --- Gasto variable -------------------------------------------------------

  fastify.post(
    '/api/shop/expenses',
    { preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE')] },
    async (request, reply) => {
      const input = createExpenseSchema.parse(request.body) as CreateVariableExpenseInput;
      await requireWriteLocationAccess(request, input.locationId);
      const actor = request.currentUser!;
      const created = await createVariableExpense(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<VariableExpense> = { ok: true, data: created };
      return body;
    },
  );

  fastify.get(
    '/api/shop/expenses',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request) => {
      const query = z.object({ locationId: z.string().uuid().optional() }).parse(request.query);
      const locationId = await resolveLocationFilter(request, query.locationId);
      const body: ApiSuccess<VariableExpense[]> = {
        ok: true,
        data: await listVariableExpenses(fastify, request.currentUser!.organizationId, {
          locationId,
        }),
      };
      return body;
    },
  );

  // --- Sin stock --------------------------------------------------------

  fastify.post(
    '/api/shop/stockouts',
    { preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE')] },
    async (request, reply) => {
      const input = createStockoutSchema.parse(request.body) as CreateStockoutEventInput;
      await requireWriteLocationAccess(request, input.locationId);
      const actor = request.currentUser!;
      const created = await createStockoutEvent(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<StockoutEvent> = { ok: true, data: created };
      return body;
    },
  );

  fastify.get(
    '/api/shop/stockouts',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE', 'DEPOSIT_MANAGER')],
    },
    async (request) => {
      const query = z.object({ locationId: z.string().uuid().optional() }).parse(request.query);
      const locationId = await resolveLocationFilter(request, query.locationId);
      const body: ApiSuccess<StockoutEvent[]> = {
        ok: true,
        data: await listStockoutEvents(fastify, request.currentUser!.organizationId, {
          locationId,
        }),
      };
      return body;
    },
  );
}
