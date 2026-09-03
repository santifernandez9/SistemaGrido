/**
 * Roles operativos confirmados por el relevamiento (docs/ETAPA-0-ANALISIS-ARQUITECTURA.md,
 * sección 7). No se agregan roles de negocio que no estén respaldados por el material del
 * cliente. SUPER_ADMIN pertenece al modelo de Hito 2 (organización múltiple) y se deja
 * fuera de este enum hasta que exista esa etapa — no se construye ni se referencia todavía.
 */
export const ROLE_CODES = ['ADMIN', 'DEPOSIT_MANAGER', 'SHOP_EMPLOYEE'] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export function isRoleCode(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}
