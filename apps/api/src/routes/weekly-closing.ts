import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WEEKLY_CLOSING_STATUSES } from '@sistema-grido/shared-types';
import type {
  ApiSuccess,
  CloseWeeklyClosingInput,
  Page,
  PrepareWeeklyClosingInput,
  ReopenWeeklyClosingInput,
  WeeklyClosing,
  WeeklyClosingDetail,
} from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import {
  closeWeeklyClosing,
  confirmWeeklyClosingReview,
  getWeeklyClosingDetail,
  listWeeklyClosings,
  prepareWeeklyClosing,
  reopenWeeklyClosing,
} from '../services/weekly-closing.js';

/**
 * Cierre Semanal del núcleo operativo (Etapa 6) -- ver
 * docs/ETAPA-6-CIERRE-SEMANAL.md. Todas las rutas bajo `/api/weekly-closings`.
 * Permisos (sección 18 del prompt, CRÍTICO): el documento del cliente
 * reserva el cierre semanal a la administración -- SÓLO ADMIN puede
 * preparar/consultar/revisar/cerrar/reabrir. Ni SHOP_EMPLOYEE ni
 * DEPOSIT_MANAGER tienen ninguna operación en este módulo (no se expanden
 * permisos sin respaldo del documento, sección 18: "no expandir permisos
 * sin respaldo").
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  status: z.enum(WEEKLY_CLOSING_STATUSES).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const prepareSchema = z.object({
  locationId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart debe tener formato YYYY-MM-DD'),
});

const closeSchema = z.object({ idempotencyKey: z.string().min(1) });

const reopenSchema = z.object({ reason: z.string().trim().min(1) });

export default async function weeklyClosingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/weekly-closings',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = prepareSchema.parse(request.body) as PrepareWeeklyClosingInput;
      const actor = request.currentUser!;
      const created = await prepareWeeklyClosing(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<WeeklyClosing> = { ok: true, data: created };
      return body;
    },
  );

  fastify.get(
    '/api/weekly-closings',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<Page<WeeklyClosing>> = {
        ok: true,
        data: await listWeeklyClosings(
          fastify,
          actor.organizationId,
          { locationId: query.locationId, status: query.status },
          { page: query.page, pageSize: query.pageSize },
        ),
      };
      return body;
    },
  );

  fastify.get(
    '/api/weekly-closings/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const actor = request.currentUser!;
      const body: ApiSuccess<WeeklyClosingDetail> = {
        ok: true,
        data: await getWeeklyClosingDetail(fastify, actor.organizationId, params.id),
      };
      return body;
    },
  );

  fastify.post(
    '/api/weekly-closings/:id/confirm-review',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const actor = request.currentUser!;
      const body: ApiSuccess<WeeklyClosingDetail> = {
        ok: true,
        data: await confirmWeeklyClosingReview(fastify, actor.organizationId, actor, params.id),
      };
      return body;
    },
  );

  fastify.post(
    '/api/weekly-closings/:id/close',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const input = closeSchema.parse(request.body) as CloseWeeklyClosingInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<WeeklyClosingDetail> = {
        ok: true,
        data: await closeWeeklyClosing(fastify, actor.organizationId, actor, params.id, input),
      };
      return body;
    },
  );

  fastify.post(
    '/api/weekly-closings/:id/reopen',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const input = reopenSchema.parse(request.body) as ReopenWeeklyClosingInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<WeeklyClosingDetail> = {
        ok: true,
        data: await reopenWeeklyClosing(fastify, actor.organizationId, actor, params.id, input),
      };
      return body;
    },
  );
}
