import type { ApiClient } from '@sistema-grido/auth-client';
import type { AttachmentPurpose, AttachmentUploadUrl } from '@sistema-grido/shared-types';
import { supabase } from './supabase.js';

/**
 * Sube una foto de merma o un comprobante de gasto a Supabase Storage
 * (sección 8/9 del prompt de Etapa 4: "nunca como base64 en la base de
 * datos"). El backend nunca toca los bytes -- sólo entrega una URL de
 * subida firmada (`POST /api/shop/attachments/upload-url`); el propio
 * dispositivo sube el archivo directo al bucket con esa firma. Devuelve el
 * `path` que después se manda como `photoPath`/`receiptPath` al crear la
 * merma o el gasto.
 */
export async function uploadAttachment(
  api: ApiClient,
  purpose: AttachmentPurpose,
  file: File,
): Promise<string> {
  const uploadUrl = await api.post<AttachmentUploadUrl>('/api/shop/attachments/upload-url', {
    purpose,
    filename: file.name,
  });

  const { error } = await supabase.storage
    .from(uploadUrl.bucket)
    .uploadToSignedUrl(uploadUrl.path, uploadUrl.token, file);
  if (error) {
    throw new Error(`No se pudo subir el archivo: ${error.message}`);
  }

  return uploadUrl.path;
}
