import 'dotenv/config';
import ExcelJS from 'exceljs';
import { prisma } from './index.js';

/**
 * Importador inicial de catálogo (Etapa 2, secciones 19-20 del prompt).
 *
 * Herramienta administrativa, NO un endpoint ni parte del runtime del backend.
 * Nunca se ejecuta en CI ni en el seed automático de desarrollo -- se corre a mano,
 * apuntando a un archivo `.xlsx` que vive FUERA del repositorio (nunca se commitea
 * un archivo con datos reales del cliente).
 *
 * Fuente: hoja "PRODUCTOS" de `HELADERIAS_HABASH — Base de Datos.xlsx` (el archivo
 * real de Habash, evidencia analizada para el modelo de Etapa 2 -- ver
 * docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Importación inicial", para el mapping
 * completo columna por columna y su justificación).
 *
 * Mapping de columnas de la hoja PRODUCTOS (A..K):
 *   A ID          -> product.code (código de negocio, ej. "P001")
 *   B CATEGORIA   -> category.name (categoría raíz; upsert si no existe)
 *   C PRODUCTO    -> product.name (y también flavor.name si la categoría es de sabor)
 *   D COSTO       -> IGNORADA (costeo, RF-039, fuera del Hito 1 -- ver Etapa 0)
 *   E BULTOS      -> IGNORADA (logística/pallet, fuera de alcance de Etapa 2)
 *   F PALLET      -> product_type.code (en realidad es "tipo": HELADO | INSUMO)
 *   G ACTIVO      -> product.active ("SI"/"NO")
 *   H STOCK_IDEAL -> IGNORADA (motor de inventario, fuera de alcance de Etapa 2)
 *   I UNIDAD      -> unit_of_measure.code ("UN" se normaliza a "UNIDAD")
 *   J PACK_X      -> product.unitsPerHandlingUnit
 *   K (sin header, código SAP numérico) -> IGNORADA (no modelada en Etapa 2 -- ver
 *      RF-004/alias en docs/ETAPA-2-CATALOGO-MAESTROS.md, "Pendientes")
 *
 * product_type y unit_of_measure son catálogos técnicos CERRADOS en esta etapa
 * (sembrados por packages/db/src/seed.ts): el importador nunca crea uno nuevo, sólo
 * busca por código -- si una fila trae un valor no sembrado, se reporta como error y
 * esa fila se salta (nunca se inventa un tipo/unidad sobre la marcha).
 *
 * Idempotente: corre por `code` (upsert) -- volver a importar el mismo archivo
 * actualiza los productos ya importados, nunca los duplica.
 */

const SHEET_NAME = 'PRODUCTOS';
const FLAVOR_CATEGORY_MARKER = 'SABOR';

interface ParsedRow {
  rowNumber: number;
  code: string;
  categoryName: string;
  productName: string;
  productTypeCode: string;
  active: boolean;
  unitOfMeasureCode: string;
  unitsPerHandlingUnit: number;
}

interface SkippedRow {
  row: number;
  reason: string;
}

export type { ParsedRow, SkippedRow };

function cell(row: ExcelJS.Row, index: number): string {
  const value = row.getCell(index).value;
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeUnitCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return upper === 'UN' ? 'UNIDAD' : upper;
}

export function parseRow(row: ExcelJS.Row, rowNumber: number): ParsedRow | SkippedRow {
  const code = cell(row, 1);
  const categoryName = cell(row, 2);
  const productName = cell(row, 3);
  const productTypeCode = cell(row, 6).toUpperCase();
  const activeRaw = cell(row, 7).toUpperCase();
  const unitOfMeasureCode = normalizeUnitCode(cell(row, 9));
  const packXRaw = cell(row, 10);

  if (!code || !productName) {
    return { row: rowNumber, reason: 'Falta ID o PRODUCTO' };
  }
  if (!categoryName) {
    return { row: rowNumber, reason: 'Falta CATEGORIA' };
  }
  if (productTypeCode !== 'HELADO' && productTypeCode !== 'INSUMO') {
    return { row: rowNumber, reason: `PALLET (tipo) desconocido: "${productTypeCode}"` };
  }
  if (activeRaw !== 'SI' && activeRaw !== 'NO') {
    return { row: rowNumber, reason: `ACTIVO desconocido: "${activeRaw}"` };
  }
  if (!['UNIDAD', 'LATA', 'CAJA'].includes(unitOfMeasureCode)) {
    return { row: rowNumber, reason: `UNIDAD desconocida: "${unitOfMeasureCode}"` };
  }
  const unitsPerHandlingUnit = packXRaw ? Number(packXRaw) : 1;
  if (!Number.isInteger(unitsPerHandlingUnit) || unitsPerHandlingUnit < 1) {
    return { row: rowNumber, reason: `PACK_X inválido: "${packXRaw}"` };
  }

  return {
    rowNumber,
    code,
    categoryName,
    productName,
    productTypeCode,
    active: activeRaw === 'SI',
    unitOfMeasureCode,
    unitsPerHandlingUnit,
  };
}

async function main(): Promise<void> {
  const sourcePath = process.argv[2] ?? process.env['CATALOG_SOURCE_XLSX_PATH'];
  if (!sourcePath) {
    console.error('Falta la ruta del archivo fuente. Uso:');
    console.error('  npm run import:catalog --workspace packages/db -- <ruta-al-archivo.xlsx>');
    console.error(
      '  (o) CATALOG_SOURCE_XLSX_PATH=<ruta> npm run import:catalog --workspace packages/db',
    );
    process.exitCode = 1;
    return;
  }

  const organizations = await prisma.organization.findMany();
  if (organizations.length !== 1) {
    console.error(
      `Se esperaba exactamente 1 organización para resolver el import automáticamente, hay ${organizations.length}. ` +
        'Corré primero el seed técnico (npm run db:seed) o revisá manualmente la base.',
    );
    process.exitCode = 1;
    return;
  }
  const organizationId = organizations[0]!.id;

  const productTypes = await prisma.productType.findMany({ where: { organizationId } });
  const productTypeByCode = new Map(productTypes.map((pt) => [pt.code, pt.id]));
  const unitsOfMeasure = await prisma.unitOfMeasure.findMany({ where: { organizationId } });
  const unitOfMeasureByCode = new Map(unitsOfMeasure.map((uom) => [uom.code, uom.id]));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    console.error(`No se encontró la hoja "${SHEET_NAME}" en ${sourcePath}`);
    process.exitCode = 1;
    return;
  }

  const parsedRows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado
    const result = parseRow(row, rowNumber);
    if ('reason' in result) {
      skipped.push(result);
    } else {
      parsedRows.push(result);
    }
  });

  console.log(`Leídas ${parsedRows.length + skipped.length} filas de datos en "${SHEET_NAME}".`);
  if (skipped.length > 0) {
    console.log(
      `\n${skipped.length} fila(s) se van a saltar (no se importan, no se sobrescribe nada):`,
    );
    for (const s of skipped) console.log(`  fila ${s.row}: ${s.reason}`);
  }

  const categoryCache = new Map<string, string>();
  const flavorCache = new Map<string, string>();
  let created = 0;
  let updated = 0;
  const failed: SkippedRow[] = [];

  for (const parsed of parsedRows) {
    try {
      let categoryId = categoryCache.get(parsed.categoryName);
      if (!categoryId) {
        // find + create explícito (no upsert por índice único): Postgres trata cada
        // NULL como distinto en una constraint UNIQUE, así que un upsert basado en
        // `parentCategoryId: null` no detecta de forma confiable una fila ya
        // existente -- mismo motivo documentado en apps/api/src/services/catalog.ts.
        const existingCategory = await prisma.category.findFirst({
          where: { organizationId, parentCategoryId: null, name: parsed.categoryName },
        });
        const category =
          existingCategory ??
          (await prisma.category.create({
            data: { organizationId, name: parsed.categoryName, parentCategoryId: null },
          }));
        categoryId = category.id;
        categoryCache.set(parsed.categoryName, categoryId);
      }

      const productTypeId = productTypeByCode.get(parsed.productTypeCode);
      const unitOfMeasureId = unitOfMeasureByCode.get(parsed.unitOfMeasureCode);
      if (!productTypeId || !unitOfMeasureId) {
        failed.push({
          row: parsed.rowNumber,
          reason: `Tipo/unidad no sembrados en la base (${parsed.productTypeCode}/${parsed.unitOfMeasureCode}) -- correr npm run db:seed primero`,
        });
        continue;
      }

      let flavorId: string | null = null;
      if (parsed.categoryName.toUpperCase().includes(FLAVOR_CATEGORY_MARKER)) {
        const cacheKey = parsed.productName;
        flavorId = flavorCache.get(cacheKey) ?? null;
        if (!flavorId) {
          const flavor = await prisma.flavor.upsert({
            where: { organizationId_name: { organizationId, name: parsed.productName } },
            update: {},
            create: { organizationId, name: parsed.productName },
          });
          flavorId = flavor.id;
          flavorCache.set(cacheKey, flavorId);
        }
      }

      const existing = await prisma.product.findFirst({
        where: { organizationId, code: parsed.code },
      });

      if (existing) {
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            name: parsed.productName,
            categoryId,
            productTypeId,
            unitOfMeasureId,
            unitsPerHandlingUnit: parsed.unitsPerHandlingUnit,
            flavorId,
            active: parsed.active,
          },
        });
        updated++;
      } else {
        await prisma.product.create({
          data: {
            organizationId,
            code: parsed.code,
            name: parsed.productName,
            categoryId,
            productTypeId,
            unitOfMeasureId,
            unitsPerHandlingUnit: parsed.unitsPerHandlingUnit,
            flavorId,
            active: parsed.active,
          },
        });
        created++;
      }
    } catch (err) {
      failed.push({
        row: parsed.rowNumber,
        reason: err instanceof Error ? err.message : 'Error desconocido',
      });
    }
  }

  console.log(
    `\nImportación terminada: ${created} producto(s) creado(s), ${updated} actualizado(s).`,
  );
  if (failed.length > 0) {
    console.log(`${failed.length} fila(s) fallaron durante la importación:`);
    for (const f of failed) console.log(`  fila ${f.row}: ${f.reason}`);
  }
  console.log(
    '\nNo importado a propósito (ver docs/ETAPA-2-CATALOGO-MAESTROS.md): costo, bultos, ' +
      'stock ideal, código SAP, alias.',
  );
}

main()
  .catch((err) => {
    console.error('Import de catálogo falló:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
