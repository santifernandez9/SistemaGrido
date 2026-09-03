import { describe, expect, it } from 'vitest';
import { ROLE_CODES } from '@sistema-grido/shared-types';

/**
 * Test puro (sin DB): protege que los 3 roles confirmados por el relevamiento
 * (docs/ETAPA-0-ANALISIS-ARQUITECTURA.md, sección 7) sigan siendo exactamente esos
 * 3 — ni de más ni de menos — hasta que una decisión funcional confirmada los cambie.
 */
describe('roles confirmados', () => {
  it('son exactamente ADMIN, DEPOSIT_MANAGER y SHOP_EMPLOYEE', () => {
    expect([...ROLE_CODES].sort()).toEqual(['ADMIN', 'DEPOSIT_MANAGER', 'SHOP_EMPLOYEE'].sort());
  });
});
