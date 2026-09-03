/**
 * Doble de prueba de @supabase/supabase-js. No hay proyecto Supabase real disponible
 * en este entorno de desarrollo/CI, así que los tests reemplazan `createClient` por
 * este mock y controlan qué devuelve `auth.getUser` (verificación de token) y
 * `auth.admin.inviteUserByEmail` (alta de usuario) en cada caso con mockGetUser/mockInviteUser.
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

let getUserResult: GetUserResult = {
  data: { user: null },
  error: { message: 'no configurado en el test' },
};
let inviteResult: InviteResult = {
  data: { user: null },
  error: { message: 'no configurado en el test' },
};

export function mockGetUser(result: GetUserResult): void {
  getUserResult = result;
}

export function mockInviteUser(result: InviteResult): void {
  inviteResult = result;
}

export function createSupabaseMockModule() {
  return {
    createClient: () => ({
      auth: {
        getUser: (_token: string) => Promise.resolve(getUserResult),
        admin: {
          inviteUserByEmail: (_email: string) => Promise.resolve(inviteResult),
        },
      },
    }),
  };
}
