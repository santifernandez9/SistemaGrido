/**
 * Doble de prueba de @supabase/supabase-js. No hay proyecto Supabase real disponible
 * en este entorno de desarrollo/CI, así que los tests reemplazan `createClient` por
 * este mock y controlan qué devuelve `auth.getUser` (verificación de token),
 * `auth.admin.inviteUserByEmail` (alta de usuario) y `auth.admin.deleteUser`
 * (compensación, Corrección 2 de Etapa 1.1) en cada caso con
 * mockGetUser/mockInviteUser/mockDeleteUser.
 *
 * Uso en un archivo de test (vi.mock debe llamarse en el propio archivo, no
 * indirectamente, por cómo Vitest hoistea los mocks):
 *
 *   import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';
 *   vi.mock('@supabase/supabase-js', createSupabaseMockModule);
 */

interface GetUserResult {
  data: { user: { id: string; email: string } | null };
  error: { message: string } | null;
}

interface InviteResult {
  data: { user: { id: string; email: string } | null };
  error: { message: string } | null;
}

interface DeleteUserResult {
  data: unknown;
  error: { message: string } | null;
}

interface SignedUploadUrlResult {
  data: { signedUrl: string; token: string; path: string } | null;
  error: { message: string } | null;
}

interface SignedUrlResult {
  data: { signedUrl: string } | null;
  error: { message: string } | null;
}

let getUserResult: GetUserResult = {
  data: { user: null },
  error: { message: 'no configurado en el test' },
};
let inviteResult: InviteResult = {
  data: { user: null },
  error: { message: 'no configurado en el test' },
};
let deleteUserResult: DeleteUserResult = { data: {}, error: null };
let deleteUserThrows: unknown = null;
let deleteUserCalls: string[] = [];

/** Etapa 4: doble de Supabase Storage (subida/lectura firmada de fotos y comprobantes). */
let signedUploadUrlResult: SignedUploadUrlResult = {
  data: { signedUrl: 'https://storage.test/upload?token=fake', token: 'fake-token', path: '' },
  error: null,
};
let signedUrlResult: SignedUrlResult = {
  data: { signedUrl: 'https://storage.test/read?token=fake' },
  error: null,
};
let storageCalls: { method: string; bucket: string; path: string }[] = [];

export function mockCreateSignedUploadUrl(result: SignedUploadUrlResult): void {
  signedUploadUrlResult = result;
}

export function mockCreateSignedUrl(result: SignedUrlResult): void {
  signedUrlResult = result;
}

export function getStorageCalls(): { method: string; bucket: string; path: string }[] {
  return storageCalls;
}

export function mockGetUser(result: GetUserResult): void {
  getUserResult = result;
}

export function mockInviteUser(result: InviteResult): void {
  inviteResult = result;
}

/** Controla qué devuelve auth.admin.deleteUser(id). Por defecto, éxito. */
export function mockDeleteUser(result: DeleteUserResult): void {
  deleteUserResult = result;
  deleteUserThrows = null;
}

/** Simula que la propia llamada a deleteUser lanza (p. ej. error de red), no que devuelve `error`. */
export function mockDeleteUserThrows(thrown: unknown): void {
  deleteUserThrows = thrown;
}

/** Ids que recibió auth.admin.deleteUser durante el test -- para confirmar qué se compensó (y qué no). */
export function getDeleteUserCalls(): string[] {
  return deleteUserCalls;
}

/** Reinicia todo el estado del mock (llamar en beforeEach). */
export function resetSupabaseMock(): void {
  getUserResult = { data: { user: null }, error: { message: 'no configurado en el test' } };
  inviteResult = { data: { user: null }, error: { message: 'no configurado en el test' } };
  deleteUserResult = { data: {}, error: null };
  deleteUserThrows = null;
  deleteUserCalls = [];
  signedUploadUrlResult = {
    data: { signedUrl: 'https://storage.test/upload?token=fake', token: 'fake-token', path: '' },
    error: null,
  };
  signedUrlResult = { data: { signedUrl: 'https://storage.test/read?token=fake' }, error: null };
  storageCalls = [];
}

export function createSupabaseMockModule() {
  return {
    createClient: () => ({
      auth: {
        getUser: (_token: string) => Promise.resolve(getUserResult),
        admin: {
          inviteUserByEmail: (_email: string) => Promise.resolve(inviteResult),
          deleteUser: (id: string) => {
            deleteUserCalls.push(id);
            if (deleteUserThrows) {
              return Promise.reject(deleteUserThrows);
            }
            return Promise.resolve(deleteUserResult);
          },
        },
      },
      storage: {
        from: (bucket: string) => ({
          createSignedUploadUrl: (path: string) => {
            storageCalls.push({ method: 'createSignedUploadUrl', bucket, path });
            const result = signedUploadUrlResult;
            if (result.data) {
              return Promise.resolve({
                data: { ...result.data, path: result.data.path || path },
                error: null,
              });
            }
            return Promise.resolve(result);
          },
          createSignedUrl: (path: string, _expiresIn: number) => {
            storageCalls.push({ method: 'createSignedUrl', bucket, path });
            return Promise.resolve(signedUrlResult);
          },
        }),
      },
    }),
  };
}
