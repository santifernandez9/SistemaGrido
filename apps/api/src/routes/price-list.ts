import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import {
  PRICE_LIST_SOURCES,
  PRICE_LIST_IMPORT_STATUSES,
  PRICE_TYPES,
} from '@sistema-grido/shared-types';
import type {
  ApiSuccess,
  ConfirmPriceListImportInput,
  CreatePriceReferenceProductMappingInput,
  Page,
  PriceListImport,
  PriceListImportPreview,
  PriceReference,
  PriceReferenceProductMapping,
  ProductPriceResolution,
} from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { ValidationError } from '../errors.js';
import {
  confirmPriceListImport,
  getPriceListImportPreview,
  listPriceListImports,
  uploadPriceListImport,
} from '../services/price-list-import.js';
import {
  createPriceReferenceProductMapping,
  deactivatePriceReferenceProductMapping,
  listPriceReferenceProductMappings,
  listPriceReferences,
  resolveProductPriceResolution,
} from '../services/price-reference-mapping.js';

/**
 * Precios/costos históricos (Etapa 6.2) -- ver
 * docs/ETAPA-6.2-CIERRE-INTEGRAL.md. Mismo criterio de permisos que
 * Etapa 5/6: SÓLO ADMIN importa listas, confirma mapeos y consulta
 * precios/costos -- ninguna operación acá para SHOP_EMPLOYEE/DEPOSIT_MANAGER.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const importsQuerySchema = z.object({
  source: z.enum(PRICE_LIST_SOURCES).optional(),
  status: z.enum(PRICE_LIST_IMPORT_STATUSES).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const confirmSchema = z.object({
  idempotencyKey: z.string().min(1),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effectiveFrom debe ser YYYY-MM-DD'),
});

const referencesQuerySchema = z.object({
  priceType: z.enum(PRICE_TYPES).optional(),
  onlyUnmapped: z.coerce.boolean().optional(),
});

const mappingsQuerySchema = z.object({
  priceReferenceId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
});

const createMappingSchema = z.object({
  priceReferenceId: z.string().uuid(),
  productId: z.string().uuid(),
});

const priceResolutionQuerySchema = z.object({ priceType: z.enum(PRICE_TYPES) });

function isMultipartFile(part: unknown): part is MultipartFile {
  return typeof part === 'object' && part !== null && (part as { type?: string }).type === 'file';
}

function isMultipartValue(part: unknown): part is MultipartValue<string> {
  return typeof part === 'object' && part !== null && (part as { type?: string }).type === 'field';
}

export default async function priceListRoutes(fastify: FastifyInstance): Promise<void> {
  // --- Importador de listas de precios/costos ------------------------------

  fastify.post(
    '/api/price-list-imports',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const sourcePart = body?.source;
      const filePart = body?.file;

      if (!isMultipartValue(sourcePart) || !sourcePart.value) {
        throw new ValidationError('Falta el campo "source"');
      }
      const source = z.enum(PRICE_LIST_SOURCES).parse(sourcePart.value);

      if (!isMultipartFile(filePart)) {
        throw new ValidationError('Falta el archivo a subir (campo "file")');
      }
      const buffer = await filePart.toBuffer();
      if (buffer.length === 0) {
        throw new ValidationError('El archivo subido está vacío');
      }

      const actor = request.currentUser!;
      const created = await uploadPriceListImport(fastify, actor.organizationId, actor, {
        source,
        originalFilename: filePart.filename,
        buffer,
      });
      reply.status(created.alreadyImported ? 200 : 201);
      const responseBody: ApiSuccess<PriceListImport> = { ok: true, data: created };
      return responseBody;
    },
  );

  fastify.get(
    '/api/price-list-imports',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const query = importsQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<Page<PriceListImport>> = {
        ok: true,
        data: await listPriceListImports(
          fastify,
          actor.organizationId,
          { source: query.source, status: query.status },
          { page: query.page, pageSize: query.pageSize },
        ),
      };
      return body;
    },
  );

  fastify.get(
    '/api/price-list-imports/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const actor = request.currentUser!;
      const body: ApiSuccess<PriceListImportPreview> = {
        ok: true,
        data: await getPriceListImportPreview(fastify, actor.organizationId, params.id),
      };
      return body;
    },
  );

  fastify.post(
    '/api/price-list-imports/:id/confirm',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const input = confirmSchema.parse(request.body) as ConfirmPriceListImportInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<PriceListImport> = {
        ok: true,
        data: await confirmPriceListImport(fastify, actor.organizationId, actor, params.id, input),
      };
      return body;
    },
  );

  // --- Referencias y mapeos --------------------------------------------------

  fastify.get(
    '/api/price-references',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const query = referencesQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<PriceReference[]> = {
        ok: true,
        data: await listPriceReferences(fastify, actor.organizationId, query),
      };
      return body;
    },
  );

  fastify.get(
    '/api/price-reference-product-mappings',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const query = mappingsQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<PriceReferenceProductMapping[]> = {
        ok: true,
        data: await listPriceReferenceProductMappings(fastify, actor.organizationId, query),
      };
      return body;
    },
  );

  fastify.post(
    '/api/price-reference-product-mappings',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createMappingSchema.parse(
        request.body,
      ) as CreatePriceReferenceProductMappingInput;
      const actor = request.currentUser!;
      const created = await createPriceReferenceProductMapping(
        fastify,
        actor.organizationId,
        actor,
        input,
      );
      reply.status(201);
      const body: ApiSuccess<PriceReferenceProductMapping> = { ok: true, data: created };
      return body;
    },
  );

  fastify.post(
    '/api/price-reference-product-mappings/:id/deactivate',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const actor = request.currentUser!;
      await deactivatePriceReferenceProductMapping(fastify, actor.organizationId, actor, params.id);
      const body: ApiSuccess<{ deactivated: true }> = { ok: true, data: { deactivated: true } };
      return body;
    },
  );

  fastify.get(
    '/api/products/:id/price-resolution',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const query = priceResolutionQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<ProductPriceResolution> = {
        ok: true,
        data: await resolveProductPriceResolution(
          fastify,
          actor.organizationId,
          params.id,
          query.priceType,
        ),
      };
      return body;
    },
  );
}
