import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { SALES_IMPORT_SOURCES, SALES_IMPORT_STATUSES } from '@sistema-grido/shared-types';
import type {
  ApiSuccess,
  BillOfMaterialItem,
  ConfirmSalesImportInput,
  CreateBillOfMaterialItemInput,
  CreateProductAliasInput,
  Page,
  ProductAlias,
  SalesImport,
  SalesImportPreview,
  UpdateBillOfMaterialItemInput,
} from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { ValidationError } from '../errors.js';
import {
  confirmSalesImport,
  getSalesImportPreview,
  listSalesImports,
  uploadSalesImport,
} from '../services/sales-import.js';
import { createProductAlias, listProductAliases } from '../services/product-alias.js';
import {
  createBillOfMaterialItem,
  listBillOfMaterialItems,
  updateBillOfMaterialItem,
} from '../services/bill-of-material.js';

/**
 * Importador de Ventas (Etapa 5) -- ver docs/ETAPA-5-IMPORTADOR-VENTAS.md.
 * Todas las rutas bajo `/api/sales-imports`, `/api/product-aliases` y
 * `/api/bill-of-material-items`. Permisos (sección 11 del prompt, CRÍTICO):
 * SÓLO ADMIN puede importar ventas, confirmar un import, crear/confirmar
 * alias, y gestionar recetas -- SHOP_EMPLOYEE y DEPOSIT_MANAGER no tienen
 * ninguna operación en este módulo.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const salesImportsQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  status: z.enum(SALES_IMPORT_STATUSES).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const confirmSchema = z.object({ idempotencyKey: z.string().min(1) });

const createAliasSchema = z.object({
  source: z.enum(SALES_IMPORT_SOURCES),
  externalCode: z.string().min(1),
  externalDescription: z.string().optional(),
  productId: z.string().uuid(),
});

const quantityPerUnitSchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,8}(\.\d{1,6})?$/,
    'Cantidad por unidad inválida: debe ser un número positivo con hasta 6 decimales',
  );

const createBomItemSchema = z.object({
  productId: z.string().uuid(),
  componentProductId: z.string().uuid(),
  quantityPerUnit: quantityPerUnitSchema,
  active: z.boolean().optional(),
});

const updateBomItemSchema = z.object({
  quantityPerUnit: quantityPerUnitSchema.optional(),
  active: z.boolean().optional(),
});

const bomQuerySchema = z.object({ productId: z.string().uuid().optional() });

function isMultipartFile(part: unknown): part is MultipartFile {
  return typeof part === 'object' && part !== null && (part as { type?: string }).type === 'file';
}

function isMultipartValue(part: unknown): part is MultipartValue<string> {
  return typeof part === 'object' && part !== null && (part as { type?: string }).type === 'field';
}

export default async function salesImportRoutes(fastify: FastifyInstance): Promise<void> {
  // --- Importador de ventas ---------------------------------------------

  fastify.post(
    '/api/sales-imports',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const locationIdPart = body?.locationId;
      const filePart = body?.file;

      if (!isMultipartValue(locationIdPart) || !locationIdPart.value) {
        throw new ValidationError('Falta el campo "locationId"');
      }
      const locationId = z.string().uuid().parse(locationIdPart.value);

      if (!isMultipartFile(filePart)) {
        throw new ValidationError('Falta el archivo a subir (campo "file")');
      }
      const buffer = await filePart.toBuffer();
      if (buffer.length === 0) {
        throw new ValidationError('El archivo subido está vacío');
      }

      const actor = request.currentUser!;
      const created = await uploadSalesImport(fastify, actor.organizationId, actor, {
        locationId,
        originalFilename: filePart.filename,
        buffer,
      });
      reply.status(created.alreadyImported ? 200 : 201);
      const responseBody: ApiSuccess<SalesImport> = { ok: true, data: created };
      return responseBody;
    },
  );

  fastify.get(
    '/api/sales-imports',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const query = salesImportsQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<Page<SalesImport>> = {
        ok: true,
        data: await listSalesImports(
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
    '/api/sales-imports/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const actor = request.currentUser!;
      const body: ApiSuccess<SalesImportPreview> = {
        ok: true,
        data: await getSalesImportPreview(fastify, actor.organizationId, params.id),
      };
      return body;
    },
  );

  fastify.post(
    '/api/sales-imports/:id/confirm',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const input = confirmSchema.parse(request.body) as ConfirmSalesImportInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<SalesImport> = {
        ok: true,
        data: await confirmSalesImport(fastify, actor.organizationId, actor, params.id, input),
      };
      return body;
    },
  );

  // --- Alias de productos -------------------------------------------------

  fastify.post(
    '/api/product-aliases',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createAliasSchema.parse(request.body) as CreateProductAliasInput;
      const actor = request.currentUser!;
      const created = await createProductAlias(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<ProductAlias> = { ok: true, data: created };
      return body;
    },
  );

  fastify.get(
    '/api/product-aliases',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const actor = request.currentUser!;
      const body: ApiSuccess<ProductAlias[]> = {
        ok: true,
        data: await listProductAliases(fastify, actor.organizationId),
      };
      return body;
    },
  );

  // --- Recetas / BOM -------------------------------------------------------

  fastify.post(
    '/api/bill-of-material-items',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createBomItemSchema.parse(request.body) as CreateBillOfMaterialItemInput;
      const actor = request.currentUser!;
      const created = await createBillOfMaterialItem(fastify, actor.organizationId, actor, input);
      reply.status(201);
      const body: ApiSuccess<BillOfMaterialItem> = { ok: true, data: created };
      return body;
    },
  );

  fastify.patch(
    '/api/bill-of-material-items/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = idParamsSchema.parse(request.params);
      const input = updateBomItemSchema.parse(request.body) as UpdateBillOfMaterialItemInput;
      const actor = request.currentUser!;
      const body: ApiSuccess<BillOfMaterialItem> = {
        ok: true,
        data: await updateBillOfMaterialItem(
          fastify,
          actor.organizationId,
          actor,
          params.id,
          input,
        ),
      };
      return body;
    },
  );

  fastify.get(
    '/api/bill-of-material-items',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const query = bomQuerySchema.parse(request.query);
      const actor = request.currentUser!;
      const body: ApiSuccess<BillOfMaterialItem[]> = {
        ok: true,
        data: await listBillOfMaterialItems(fastify, actor.organizationId, {
          productId: query.productId,
        }),
      };
      return body;
    },
  );
}
