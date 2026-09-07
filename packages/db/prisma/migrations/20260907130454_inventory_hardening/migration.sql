-- Etapa 3.1 — Hardening del motor de inventario
-- Ver docs/ETAPA-3.1-HARDENING-INVENTARIO.md para el detalle completo.
--
-- Corrige el Problema 1 (reversión concurrente) y prepara el campo usado por
-- el Problema 3 (idempotencia semántica). No modifica ninguna migración ya
-- aplicada de Etapas 1/2/2.1/3.

-- AlterTable
-- Huella de la identidad semántica del payload de un movimiento con
-- idempotencyKey (Problema 3): permite distinguir un retry legítimo (mismo
-- fingerprint) de una reutilización de clave con datos incompatibles
-- (fingerprint distinto) sin tener que decidirlo comparando campo por campo
-- en cada lugar que lo necesite.
ALTER TABLE "inventory_movement" ADD COLUMN "idempotency_fingerprint" TEXT;

-- Problema 1 (reversión concurrente): a lo sumo una fila puede tener un
-- reverses_movement_id dado, por organización. Índice único PARCIAL (no
-- expresable declarativamente en schema.prisma): sólo aplica cuando
-- reverses_movement_id IS NOT NULL, así que no afecta a los movimientos
-- "normales" (que nunca revierten a nadie).
--
-- Es la SEGUNDA capa de la corrección -- la primera y la que realmente
-- resuelve la condición de carrera es el UPDATE atómico condicional
-- (`UPDATE ... WHERE id = $1 AND status = 'ACTIVE'`, dentro de una
-- transacción) en reverseMovement() (apps/api/src/services/inventory-ledger.ts):
-- como ambas transacciones concurrentes toman el lock de fila del movimiento
-- original al intentar ese UPDATE, Postgres serializa el acceso -- la
-- segunda transacción espera a que la primera confirme, y al reintentar su
-- propio UPDATE ya no encuentra la fila en ACTIVE (0 filas afectadas), así
-- que nunca llega a insertar una segunda reversión. Este índice es la
-- garantía estructural final: protege el invariante "1 movimiento original
-- -> 0 o 1 reversión" incluso ante un futuro bug o un camino de escritura
-- que no pase por reverseMovement().
CREATE UNIQUE INDEX "inventory_movement_unique_reversal_per_original" ON "inventory_movement"("organization_id", "reverses_movement_id") WHERE "reverses_movement_id" IS NOT NULL;

-- Protección del ledger contra UPDATE destructivo (sección "Protección del
-- ledger" del prompt de Etapa 3.1). Hasta esta migración, nada a nivel de
-- PostgreSQL impedía un `UPDATE inventory_movement SET quantity = ...`
-- directo -- sólo la disciplina del código de aplicación (ningún servicio
-- lo hace). Este trigger lo convierte en una garantía real de la base de
-- datos: la ÚNICA modificación permitida sobre una fila ya creada es
-- `status` pasando de ACTIVE a REVERSED (la reversión legítima, sección 13
-- del prompt de Etapa 3) -- cualquier otro cambio, a cualquier columna, se
-- rechaza.
--
-- `to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status'`
-- compara las dos filas completas salvo la columna `status`: si algo más
-- cambió, aborta. Se prefiere esto a listar cada columna a mano porque no
-- hay que recordar actualizar el trigger si en el futuro se agrega una
-- columna nueva a la tabla.
--
-- DELETE queda deliberadamente SIN bloquear en esta migración: la limpieza
-- de datos entre tests (apps/api/src/test/db-helpers.ts, resetCoreTables)
-- depende de poder truncar esta tabla, y una política de DELETE robusta en
-- producción (ej. revocar el privilegio DELETE al rol de runtime de la
-- aplicación, distinto del rol de migraciones/tests) es una decisión de
-- separación de roles de base de datos que excede el alcance de este
-- hardening puntual -- queda documentada como pendiente técnico explícito
-- en docs/ETAPA-3.1-HARDENING-INVENTARIO.md, no implementada a medias acá.
CREATE OR REPLACE FUNCTION inventory_movement_prevent_mutation() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'inventory_movement es inmutable: sólo se permite cambiar "status" (Etapa 3.1, docs/INVARIANTES-INVENTARIO.md)';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'REVERSED') THEN
    RAISE EXCEPTION 'Transición de status no permitida en inventory_movement: % -> % (sólo ACTIVE -> REVERSED)', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_movement_prevent_mutation
BEFORE UPDATE ON "inventory_movement"
FOR EACH ROW EXECUTE FUNCTION inventory_movement_prevent_mutation();
