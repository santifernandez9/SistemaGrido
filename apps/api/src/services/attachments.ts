import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { InternalError } from '../errors.js';

/**
 * Fotos/comprobantes de Etapa 4 (mermas y gastos variables) -- sección 8/9
 * del prompt: "usar Supabase Storage... no guardarse como base64 en la base
 * de datos". El backend NUNCA recibe los bytes del archivo: sólo firma una
 * URL de subida (el frontend sube directo a Supabase Storage con esa URL) y,
 * cuando corresponde mostrarla, firma una URL de lectura de corta duración.
 * Sólo se persiste la RUTA dentro del bucket -- ver `Waste.photoPath` /
 * `VariableExpense.receiptPath` en packages/db/prisma/schema.prisma.
 */

export type AttachmentPurpose = 'WASTE_PHOTO' | 'EXPENSE_RECEIPT';

const READ_URL_EXPIRY_SECONDS = 300;

function sanitizeFilename(filename: string): string {
  // Sólo para que la ruta en el bucket sea legible -- no es la fuente de
  // verdad de ningún control de acceso (eso lo da la URL firmada en sí).
  const trimmed = filename.trim().slice(-120);
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_') || 'archivo';
}

export interface CreateUploadUrlResult {
  bucket: string;
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * Firma una URL de subida de un único uso para un archivo nuevo. El
 * `path` incluye `organizationId` y `purpose` para que las fotos/comprobantes
 * de una organización nunca puedan pisar las de otra ni confundirse entre
 * mermas y gastos.
 */
export async function createUploadUrl(
  fastify: FastifyInstance,
  organizationId: string,
  purpose: AttachmentPurpose,
  filename: string,
): Promise<CreateUploadUrlResult> {
  const bucket = fastify.config.shopOps.attachmentsBucket;
  const path = `${organizationId}/${purpose}/${randomUUID()}-${sanitizeFilename(filename)}`;

  const { data, error } = await fastify.supabase.admin.storage
    .from(bucket)
    .createSignedUploadUrl(path);

  if (error || !data) {
    fastify.log.error(
      { err: error, organizationId, purpose },
      'No se pudo firmar la URL de subida',
    );
    throw new InternalError('No se pudo preparar la subida del archivo; intentá de nuevo.');
  }

  return { bucket, path: data.path, signedUrl: data.signedUrl, token: data.token };
}

/**
 * Firma una URL de lectura de corta duración para mostrarle una foto/
 * comprobante ya subido a un ADMIN (sección 8 del prompt: "poder
 * consultarse posteriormente por Admin"). Nunca se persiste esta URL -- se
 * recalcula en cada respuesta, así el bucket puede quedar privado sin
 * política pública.
 */
export async function createReadUrl(
  fastify: FastifyInstance,
  path: string,
): Promise<string | null> {
  const bucket = fastify.config.shopOps.attachmentsBucket;
  const { data, error } = await fastify.supabase.admin.storage
    .from(bucket)
    .createSignedUrl(path, READ_URL_EXPIRY_SECONDS);

  if (error || !data) {
    fastify.log.error({ err: error, path }, 'No se pudo firmar la URL de lectura');
    return null;
  }
  return data.signedUrl;
}
