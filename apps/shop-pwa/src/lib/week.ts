/**
 * Lunes de la semana en curso, hora LOCAL del dispositivo (sección 2 del
 * prompt de Etapa 4: "weekStart lo calcula el frontend"). Formato
 * YYYY-MM-DD -- el mismo que espera `SubmitInventoryCountInput.weekStart`.
 */
export function currentWeekStartISO(now: Date = new Date()): string {
  const day = now.getDay(); // 0 = domingo ... 6 = sábado
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  const yyyy = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
