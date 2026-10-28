import { describe, expect, it } from 'vitest';
import { currentWeekStartISO } from './week.js';

describe('currentWeekStartISO', () => {
  it('un miércoles devuelve el lunes de esa misma semana', () => {
    // 2026-09-09 es miércoles.
    expect(currentWeekStartISO(new Date(2026, 8, 9))).toBe('2026-09-07');
  });

  it('un lunes se devuelve a sí mismo', () => {
    expect(currentWeekStartISO(new Date(2026, 8, 7))).toBe('2026-09-07');
  });

  it('un domingo devuelve el lunes ANTERIOR, no el siguiente', () => {
    // 2026-09-13 es domingo -- pertenece a la semana que empezó el 2026-09-07.
    expect(currentWeekStartISO(new Date(2026, 8, 13))).toBe('2026-09-07');
  });

  it('cruza de mes correctamente', () => {
    // 2026-10-01 es jueves -- lunes de esa semana es 2026-09-28.
    expect(currentWeekStartISO(new Date(2026, 9, 1))).toBe('2026-09-28');
  });
});
