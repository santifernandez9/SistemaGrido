import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiSuccess } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { createUploadUrl, type AttachmentPurpose } from '../services/attachments.js';

const createUploadUrlSchema = z.object({
  purpose: z.enum(['WASTE_PHOTO', 'EXPENSE_RECEIPT']),
  filename: z.string().min(1).max(200),
});

/**
 * Etapa 4: subida de fotos de merma y comprobantes de gasto vía Supabase
 * Storage. Roles: los mismos que pueden crear la merma/el gasto que la
 * usará -- ver docs/ETAPA-4-APP-HELADERIA.md, "Permisos".
 */
export default async function attachmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/shop/attachments/upload-url',
    { preHandler: [fastify.authenticate, requireRole('ADMIN', 'SHOP_EMPLOYEE')] },
    async (request, reply) => {
      const input = createUploadUrlSchema.parse(request.body);
      const result = await createUploadUrl(
        fastify,
        request.currentUser!.organizationId,
        input.purpose as AttachmentPurpose,
        input.filename,
      );
      reply.status(201);
      const body: ApiSuccess<typeof result> = { ok: true, data: result };
      return body;
    },
  );
}
