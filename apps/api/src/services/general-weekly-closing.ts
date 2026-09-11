import type { FastifyInstance } from 'fastify';
import type {
  CloseGeneralWeeklyClosingInput,
  GeneralWeeklyClosing as GeneralWeeklyClosingDto,
  GeneralWeeklyClosingLocationStatus,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, ValidationError } from '../errors.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';

/**
 * Cierre semanal GENERAL (Etapa 6.2, sección 12 del prompt, CONFIRMADO: "la
 * semana cierra cuando TODAS las heladerías requeridas terminaron su
 * conteo") -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md. Agrega la vista/estado
 * a NIVEL SEMANA sobre los `WeeklyClosing` por ubicación de Etapa 6/6.1, que
 * siguen existiendo intactos para la trazabilidad individual -- este
 * servicio nunca los reemplaza, sólo los CONSULTA y agrega un registro
 * propio (`GeneralWeeklyClosing`) para el gesto de cierre general en sí.
 *
 * "Heladerías requeridas" = `Location.active && Location.type ===
 * 'ICE_CREAM_SHOP'` de la organización -- NUNCA una lista hardcodeada
 * (sección 12 del prompt: evitar que una sola heladería cerrada haga
 * parecer cerrada toda la semana, y viceversa, evitar que una heladería
 * dada de baja bloquee para siempre un cierre general).
 */

const CLOSE_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'close_idempotency_key'] as const;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parsePeriodStart(periodStart: string): Date {
  const date = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('periodStart inválido: debe ser una fecha (YYYY-MM-DD)');
  }
  if (date.getUTCDay() !== 1) {
    throw new ValidationError(
      'periodStart debe ser un lunes (documento del cliente, sección 24: "Período: lunes a domingo")',
    );
  }
  return date;
}

async function computeLocationStatuses(
  fastify: FastifyInstance,
  organizationId: string,
  periodStart: Date,
): Promise<GeneralWeeklyClosingLocationStatus[]> {
  const requiredLocations = await fastify.db.location.findMany({
    where: { organizationId, active: true, type: 'ICE_CREAM_SHOP' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (requiredLocations.length === 0) return [];

  const closings = await fastify.db.weeklyClosing.findMany({
    where: {
      organizationId,
      periodStart,
      locationId: { in: requiredLocations.map((l) => l.id) },
    },
    select: { id: true, locationId: true, status: true },
  });
  const closingByLocation = new Map(closings.map((c) => [c.locationId, c]));

  return requiredLocations.map((location) => {
    const closing = closingByLocation.get(location.id);
    return {
      locationId: location.id,
      locationName: location.name,
      weeklyClosingId: closing?.id ?? null,
      weeklyClosingStatus: closing?.status ?? null,
      // REOPENED cuenta como "no lista" hasta volver a cerrar -- sección 12
      // del prompt: nunca dar por cerrada una semana con una revisión
      // reabierta pendiente.
      ready: closing?.status === 'CLOSED',
    };
  });
}

export async function getGeneralWeeklyClosingDetail(
  fastify: FastifyInstance,
  organizationId: string,
  periodStartInput: string,
): Promise<GeneralWeeklyClosingDto> {
  const periodStart = parsePeriodStart(periodStartInput);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);

  const [locations, existing] = await Promise.all([
    computeLocationStatuses(fastify, organizationId, periodStart),
    fastify.db.generalWeeklyClosing.findFirst({
      where: { organizationId, periodStart },
      include: { closedBy: { select: { displayName: true } } },
    }),
  ]);

  const allReady = locations.length > 0 && locations.every((l) => l.ready);

  return {
    id: existing?.id ?? null,
    organizationId,
    periodStart: toIsoDate(periodStart),
    periodEnd: toIsoDate(periodEnd),
    status: existing?.status ?? 'OPEN',
    closedById: existing?.closedById ?? null,
    closedByName: existing?.closedBy?.displayName ?? null,
    closedAt: existing?.closedAt?.toISOString() ?? null,
    locations,
    canClose: existing?.status !== 'CLOSED' && allReady,
  };
}

function computeCloseFingerprint(organizationId: string, periodStart: string): string {
  return JSON.stringify({ organizationId, periodStart });
}

async function resolveCloseConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  periodStart: Date,
  periodStartIso: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<GeneralWeeklyClosingDto> {
  const winner = await fastify.db.generalWeeklyClosing.findFirst({
    where: { organizationId, periodStart },
  });
  if (!winner) {
    fastify.log.error(
      { organizationId, periodStart: periodStartIso, idempotencyKey },
      'Etapa 6.2: colisión de idempotencia de cierre general sin fila encontrada al reconsultar',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de este cierre general por una condición de carrera inesperada; reintentá la solicitud.',
    );
  }
  if (
    winner.closeIdempotencyKey === idempotencyKey &&
    winner.closeIdempotencyFingerprint === fingerprint
  ) {
    return getGeneralWeeklyClosingDetail(fastify, organizationId, periodStartIso);
  }
  throw new ConflictError('Este cierre general ya fue cerrado con una clave distinta.');
}

/**
 * Cierre general (sección 12 del prompt): sólo posible cuando TODAS las
 * heladerías requeridas tienen su `WeeklyClosing` en CLOSED para el mismo
 * período. Idempotente -- mismo patrón endurecido de Etapa 3.1/4.1/5.1/6
 * (clave + fingerprint + UNIQUE + resolución explícita de carrera
 * reconsultando Postgres).
 */
export async function closeGeneralWeeklyClosing(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  periodStartInput: string,
  input: CloseGeneralWeeklyClosingInput,
): Promise<GeneralWeeklyClosingDto> {
  const periodStart = parsePeriodStart(periodStartInput);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);
  const fingerprint = computeCloseFingerprint(organizationId, periodStartInput);

  const existing = await fastify.db.generalWeeklyClosing.findFirst({
    where: { organizationId, periodStart },
  });
  if (existing?.closeIdempotencyKey !== undefined && existing?.closeIdempotencyKey !== null) {
    if (
      existing.closeIdempotencyKey === input.idempotencyKey &&
      existing.closeIdempotencyFingerprint === fingerprint
    ) {
      return getGeneralWeeklyClosingDetail(fastify, organizationId, periodStartInput);
    }
    throw new ConflictError('Este cierre general ya fue cerrado con una clave distinta.');
  }

  const locations = await computeLocationStatuses(fastify, organizationId, periodStart);
  const allReady = locations.length > 0 && locations.every((l) => l.ready);
  if (!allReady) {
    const missing = locations.filter((l) => !l.ready).map((l) => l.locationName);
    throw new ConflictError(
      locations.length === 0
        ? 'No hay ninguna heladería activa que requiera cierre en esta organización.'
        : `No se puede cerrar la semana a nivel general: falta el cierre de ${missing.length} heladería(s): ${missing.join(', ')}.`,
    );
  }

  try {
    await fastify.db.$transaction(async (tx) => {
      const created = await tx.generalWeeklyClosing.upsert({
        where: { organizationId_periodStart: { organizationId, periodStart } },
        create: {
          organizationId,
          periodStart,
          periodEnd,
          status: 'CLOSED',
          closedById: actor.id,
          closedAt: new Date(),
          closeIdempotencyKey: input.idempotencyKey,
          closeIdempotencyFingerprint: fingerprint,
        },
        update: {
          status: 'CLOSED',
          closedById: actor.id,
          closedAt: new Date(),
          closeIdempotencyKey: input.idempotencyKey,
          closeIdempotencyFingerprint: fingerprint,
        },
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'GENERAL_WEEKLY_CLOSING_CLOSED',
        module: 'WEEKLY_CLOSING',
        entityType: 'general_weekly_closing',
        entityId: created.id,
        afterValue: {
          organizationId,
          periodStart: periodStartInput,
          locationsClosed: locations.length,
        },
      });
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, CLOSE_IDEMPOTENCY_KEY_TARGET)) {
      return resolveCloseConflictAfterRace(
        fastify,
        organizationId,
        periodStart,
        periodStartInput,
        input.idempotencyKey,
        fingerprint,
      );
    }
    throw err;
  }

  return getGeneralWeeklyClosingDetail(fastify, organizationId, periodStartInput);
}
