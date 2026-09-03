/**
 * Tipos de la infraestructura de auditoría base (Etapa 1).
 *
 * Sólo se tipan acciones/módulos que existen en el Core de esta etapa (sesión y
 * gestión de usuarios). Los módulos funcionales de etapas futuras (stock, ventas,
 * mermas, caja, cierres, etc.) NO se listan acá todavía — cuando esos módulos se
 * construyan, agregarán sus propias acciones sin tener que tocar esta base, porque
 * `module` y `action` son `string` libres a nivel de esquema (ver packages/db) y
 * estas listas son sólo las conocidas y usadas hoy por apps/api.
 */
export const AUDIT_RESULTS = ['OK', 'ERROR', 'REJECTED'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const CORE_AUDIT_MODULES = ['AUTH', 'USERS'] as const;
export type CoreAuditModule = (typeof CORE_AUDIT_MODULES)[number];

export const CORE_AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'USER_INVITED',
  'USER_UPDATED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
] as const;
export type CoreAuditAction = (typeof CORE_AUDIT_ACTIONS)[number];
