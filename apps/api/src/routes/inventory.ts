import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DECIMAL_QUANTITY_PATTERN, MOVEMENT_TYPES } from '@sistema-grido/shared-types';
import type {
  ApiSuccess,
  InventoryMovement,
  Page,
  StockBalance,
} from '@sistema-grido/shared-types';
import { requireLocationAccess, requireRole } from '../plugins/authorize.js';
import { AuthorizationError } from '../errors.js';
import {
  createAdjustment,
  createInitialStock,
  getMovementDetail,
  getStockBalances,
  listMovements,
  reverseMovement,
} from '../services/inventory-ledger.js';

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Fecha inválida');

const stockQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
});

const movementsQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  movementType: z.enum(MOVEMENT_TYPES).optional(),
  occurredFrom: isoDate.optional(),
  occurredTo: isoDate.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Cantidad decimal como STRING (Etapa 3.1, corrección del Problema 2: "no
 * utilizar float de JavaScript como representación intermedia de cantidades
 * que requieran precisión"). Sólo valida el FORMATO acá (signo opcional,
 * hasta 3 decimales, misma escala que NUMERIC(14,3)) -- el signo/cero se
 * valida contra la operación concreta en el servicio
 * (apps/api/src/services/inventory-ledger.ts), usando `Prisma.Decimal`
 * directamente sobre el string, nunca `Number(...)`.
 */
const decimalQuantitySchema = z
  .string()
  .trim()
  .regex(
    DECIMAL_QUANTITY_PATTERN,
    'Cantidad inválida: debe ser un número decimal (opcionalmente negativo) con hasta 3 decimales, ej. "12.375"',
  );

const createInitialStockSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  enteredQuantity: decimalQuantitySchema,
  occurredAt: isoDate.optional(),
  idempotencyKey: z.string().min(1).optional(),
});

const createAdjustmentSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  enteredQuantity: decimalQuantitySchema,
  reason: z.string().min(1, 'El ajuste requiere un motivo'),
  occurredAt: isoDate.optional(),
  idempotencyKey: z.string().min(1).optional(),
});

const reverseMovementSchema = z.object({
  reason: z.string().min(1, 'La reversión requiere un motivo'),
});

/**
 * Resuelve a qué `locationId` debe restringirse la consulta para el usuario
 * actual (sección 20 del prompt de Etapa 3, RESPALDADO por la tabla de
 * actores de docs/ETAPA-0-ANALISIS-ARQUITECTURA.md sección 7: Admin ve
 * "stock completos", Encargado de depósito ve "Stock depósito", Empleada ve
 * "Stock de su heladería"). ADMIN puede pedir cualquier ubicación o ninguna
 * (todas); el resto sólo puede pedir la suya -- si pide otra, se rechaza
 * explícitamente en vez de devolver silenciosamente datos de la propia.
 */
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

/**
 * Motor de inventario (Etapa 3) -- consultas de stock/movimientos abiertas a
 * los tres roles (con alcance de ubicación restringido para Encargado de
 * depósito y Empleada de heladería); operaciones administrativas (stock
 * inicial, ajuste, reversión) sólo ADMIN -- ver docs/ETAPA-3-MOTOR-INVENTARIO.md,
 * sección "Autorización".
 */
export default async function inventoryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/inventory/stock',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'DEPOSIT_MANAGER', 'SHOP_EMPLOYEE')],
    },
    async (request) => {
      const query = stockQuerySchema.parse(request.query);
      const locationId = await resolveLocationFilter(request, query.locationId);
      const body: ApiSuccess<StockBalance[]> = {
        ok: true,
        data: await getStockBalances(fastify, request.currentUser!.organizationId, {
          locationId,
          productId: query.productId,
        }),
      };
      return body;
    },
  );

  fastify.get(
    '/api/inventory/movements',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'DEPOSIT_MANAGER', 'SHOP_EMPLOYEE')],
    },
    async (request) => {
      const query = movementsQuerySchema.parse(request.query);
      const locationId = await resolveLocationFilter(request, query.locationId);
      const body: ApiSuccess<Page<InventoryMovement>> = {
        ok: true,
        data: await listMovements(
          fastify,
          request.currentUser!.organizationId,
          {
            locationId,
            productId: query.productId,
            movementType: query.movementType,
            occurredFrom: query.occurredFrom,
            occurredTo: query.occurredTo,
          },
          { page: query.page, pageSize: query.pageSize },
        ),
      };
      return body;
    },
  );

  fastify.get(
    '/api/inventory/movements/:id',
    {
      preHandler: [fastify.authenticate, requireRole('ADMIN', 'DEPOSIT_MANAGER', 'SHOP_EMPLOYEE')],
    },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const movement = await getMovementDetail(
        fastify,
        request.currentUser!.organizationId,
        params.id,
      );
      if (request.currentUser!.roleCode !== 'ADMIN') {
        await requireLocationAccess(movement.locationId)(request, undefined as never);
      }
      const body: ApiSuccess<InventoryMovement> = { ok: true, data: movement };
      return body;
    },
  );

  fastify.post(
    '/api/inventory/stock/initial',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createInitialStockSchema.parse(request.body);
      const admin = request.currentUser!;
      const created = await createInitialStock(fastify, admin.organizationId, admin, input);
      reply.status(201);
      const body: ApiSuccess<InventoryMovement> = { ok: true, data: created };
      return body;
    },
  );

  fastify.post(
    '/api/inventory/adjustments',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createAdjustmentSchema.parse(request.body);
      const admin = request.currentUser!;
      const created = await createAdjustment(fastify, admin.organizationId, admin, input);
      reply.status(201);
      const body: ApiSuccess<InventoryMovement> = { ok: true, data: created };
      return body;
    },
  );

  fastify.post(
    '/api/inventory/movements/:id/reverse',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = idParamsSchema.parse(request.params);
      const input = reverseMovementSchema.parse(request.body);
      const admin = request.currentUser!;
      const reversal = await reverseMovement(
        fastify,
        admin.organizationId,
        admin,
        params.id,
        input.reason,
      );
      reply.status(201);
      const body: ApiSuccess<InventoryMovement> = { ok: true, data: reversal };
      return body;
    },
  );
}
