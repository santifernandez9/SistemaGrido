/**
 * Tipos de ubicación (docs/ETAPA-0-ANALISIS-ARQUITECTURA.md, sección 5 / 8): entidad
 * genérica `location` con `type` configurable, tal como pide explícitamente el
 * documento de requisitos del cliente (§5) para no hardcodear "depósito"/"heladería".
 */
export const LOCATION_TYPES = ['DEPOT', 'ICE_CREAM_SHOP', 'STORE', 'OTHER'] as const;

export type LocationType = (typeof LOCATION_TYPES)[number];

export function isLocationType(value: string): value is LocationType {
  return (LOCATION_TYPES as readonly string[]).includes(value);
}

export interface LocationSummary {
  id: string;
  name: string;
  type: LocationType;
  active: boolean;
}
