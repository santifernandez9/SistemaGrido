import type { RoleCode } from './roles.js';

/**
 * Perfil de un usuario individual (docs/ETAPA-0-ANALISIS-ARQUITECTURA.md, sección 10.1,
 * P-001 resuelta: identidad individual real — nunca una cuenta compartida por rol/ubicación).
 */
export interface UserProfile {
  id: string;
  organizationId: string;
  roleCode: RoleCode;
  /** Ubicación asignada. null para ADMIN (acceso a toda la organización). */
  defaultLocationId: string | null;
  displayName: string;
  email: string;
  active: boolean;
  createdAt: string;
}

export interface InviteUserInput {
  email: string;
  displayName: string;
  roleCode: RoleCode;
  defaultLocationId: string | null;
}

export interface UpdateUserInput {
  displayName?: string;
  roleCode?: RoleCode;
  defaultLocationId?: string | null;
  active?: boolean;
}
