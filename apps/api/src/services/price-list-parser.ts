import ExcelJS from 'exceljs';

/**
 * Parsers de las DOS listas reales de Grido (Etapa 6.2, sección 9 del
 * prompt) -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md, "Archivos reales
 * inspeccionados". Construidos EXCLUSIVAMENTE contra la estructura real
 * verificada con `openpyxl`/`exceljs` de los dos archivos adjuntos:
 *
 * 1. "Lista_Precio_Costo.xlsx", hoja "Precio Helacor" (A1:N118): título en
 *    B1 (fusionada B1:D1), encabezado en fila 2 (B2 = rótulo de período
 *    libre, C2 = "Precio S/ IVA", D2 = "Precio C/ IVA"), luego filas
 *    intercaladas de:
 *      - CATEGORÍA: sólo B tiene texto (fusionada B:D en el archivo real,
 *        pero eso no se asume -- se detecta porque C no es numérico).
 *      - PRODUCTO: B = descripción, C = precio S/IVA (número o fórmula),
 *        D = precio C/IVA (número o fórmula "=C*1.21"). Se usa
 *        EXCLUSIVAMENTE D (C/IVA) para `rawValueWithTax` -- C/IVA es el
 *        costo confirmado por el cliente para valorización (sección 10).
 *      - fila vacía (separador entre secciones).
 *    Sin código de artículo en ninguna fila -- confirmado inspeccionando
 *    las 118 filas reales.
 *
 * 2. "Lista_Valor_venta_de_SEP2026.xlsx", hoja "Precios Grido" (A1:F92):
 *    mismo patrón (título B1, encabezado fila 2, categoría/producto/vacío),
 *    pero con UN SOLO precio en C (precio de venta) -- sin columna S/IVA.
 *    También sin código de artículo.
 *
 * En ambos casos el nombre exacto de la hoja es la señal estructural real
 * que identifica el formato -- un archivo sin esa hoja se rechaza
 * explícitamente (mismo criterio que `sales-import-parser.ts`: nunca
 * intentar adivinar/adaptar un formato distinto al inspeccionado).
 *
 * `rowNumber` acá es el número de fila EXACTO de Excel (1-based, tal como
 * lo ve un usuario al abrir el archivo) -- a propósito distinto de la
 * convención 0-based que usa `sales-import-parser.ts` para su fuente .xls
 * (xlrd), documentado como desviación deliberada: facilita que un ADMIN
 * ubique un error señalado por fila directamente en el Excel.
 */

export class UnsupportedPriceListFileError extends Error {}

export interface ParsedPriceListRow {
  rowNumber: number;
  rawLabel: string;
  rawCategory: string | null;
  /** Number en JS sólo transitoriamente -- el llamador lo convierte a
   * `Prisma.Decimal` de inmediato; nunca se usa para aritmética acá. */
  rawValueWithoutTax: number | null;
  rawValueWithTax: number | null;
  status: 'VALID' | 'ERROR';
  errorMessage: string | null;
}

export interface ParsedPriceList {
  rawPeriodLabel: string | null;
  rows: ParsedPriceListRow[];
}

const LABEL_COLUMN = 2; // B
const VALUE_WITHOUT_TAX_COLUMN = 3; // C
const VALUE_WITH_TAX_COLUMN = 4; // D
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 3;

function cellText(cell: ExcelJS.Cell): string {
  const text = cell.text;
  return typeof text === 'string' ? text.trim() : '';
}

/** Devuelve el número de una celda, resolviendo el `.result` de una fórmula
 * (ej. "=C4*1.21") -- nunca evalúa fórmulas por su cuenta, sólo lee el
 * resultado que el propio archivo Excel ya calculó y guardó. */
function cellNumber(cell: ExcelJS.Cell): number | null {
  const value = cell.value;
  if (typeof value === 'number') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    'result' in value &&
    typeof (value as { result: unknown }).result === 'number'
  ) {
    return (value as { result: number }).result;
  }
  return null;
}

async function loadWorksheet(
  buffer: Buffer,
  expectedSheetName: string,
): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new UnsupportedPriceListFileError(
      'No se pudo leer el archivo subido. Verificá que sea un archivo .xlsx válido.',
    );
  }
  const worksheet = workbook.getWorksheet(expectedSheetName);
  if (!worksheet) {
    throw new UnsupportedPriceListFileError(
      `El archivo no tiene la hoja esperada "${expectedSheetName}". Verificá que sea el archivo real exportado por Grido, sin renombrar hojas.`,
    );
  }
  return worksheet;
}

/**
 * Recorre filas [FIRST_DATA_ROW..rowCount] clasificando cada una en:
 * vacía (se ignora), CATEGORÍA (B con texto, `valueWithTax` no numérico --
 * actualiza `currentCategory`, no genera fila), o PRODUCTO (genera una
 * `ParsedPriceListRow`). `hasSeparateTaxColumn` distingue el archivo de
 * costos (dos columnas de precio) del de venta (una sola, C).
 */
/**
 * La columna C ("Precio S/ IVA" en el archivo de costos, el único precio en
 * el de venta) es el indicador PRIMARIO de "esta fila es un producto, no
 * una categoría" -- está presente en el 100% de las filas de producto
 * reales inspeccionadas de ambos archivos. Para el archivo de costos, la
 * columna D ("Precio C/ IVA") se valida POR SEPARADO: si C tiene precio
 * pero D no, es un dato incompleto de ESA fila (ERROR), nunca se confunde
 * con un encabezado de categoría (que nunca tiene C poblado).
 */
function parseRows(
  worksheet: ExcelJS.Worksheet,
  hasSeparateTaxColumn: boolean,
): ParsedPriceListRow[] {
  const rows: ParsedPriceListRow[] = [];
  let currentCategory: string | null = null;

  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const label = cellText(row.getCell(LABEL_COLUMN));
    const primaryValue = cellNumber(row.getCell(VALUE_WITHOUT_TAX_COLUMN));

    if (!label) {
      // Fila vacía/separadora -- ignorada, nunca un error (es una
      // particularidad real y esperada del archivo, sección 9 del prompt).
      continue;
    }

    if (primaryValue === null) {
      // Sin precio numérico en C: es un encabezado de CATEGORÍA (ej.
      // "POSTRES"), no un producto -- se recuerda para las filas
      // siguientes, nunca se emite como fila de producto ni como error.
      currentCategory = label;
      continue;
    }

    if (!hasSeparateTaxColumn) {
      rows.push({
        rowNumber,
        rawLabel: label,
        rawCategory: currentCategory,
        rawValueWithoutTax: null,
        rawValueWithTax: primaryValue,
        status: 'VALID',
        errorMessage: null,
      });
      continue;
    }

    const valueWithTax = cellNumber(row.getCell(VALUE_WITH_TAX_COLUMN));
    if (valueWithTax === null) {
      rows.push({
        rowNumber,
        rawLabel: label,
        rawCategory: currentCategory,
        rawValueWithoutTax: primaryValue,
        rawValueWithTax: null,
        status: 'ERROR',
        errorMessage: 'Falta el valor de "Precio C/ IVA" para esta fila.',
      });
      continue;
    }

    rows.push({
      rowNumber,
      rawLabel: label,
      rawCategory: currentCategory,
      rawValueWithoutTax: primaryValue,
      rawValueWithTax: valueWithTax,
      status: 'VALID',
      errorMessage: null,
    });
  }

  return rows;
}

/** Lista de COSTOS ("Lista_Precio_Costo.xlsx", hoja "Precio Helacor"). */
export async function parseHelacorCostListFile(buffer: Buffer): Promise<ParsedPriceList> {
  const worksheet = await loadWorksheet(buffer, 'Precio Helacor');

  const headerRow = worksheet.getRow(HEADER_ROW);
  const withoutTaxHeader = cellText(headerRow.getCell(VALUE_WITHOUT_TAX_COLUMN)).toLowerCase();
  const withTaxHeader = cellText(headerRow.getCell(VALUE_WITH_TAX_COLUMN)).toLowerCase();
  if (!withoutTaxHeader.includes('s/') || !withTaxHeader.includes('c/')) {
    throw new UnsupportedPriceListFileError(
      'El archivo de costos no tiene las columnas esperadas ("Precio S/ IVA" / "Precio C/ IVA") en la fila 2. ' +
        'Verificá que sea el archivo real de Helacor, sin modificar encabezados.',
    );
  }

  const rawPeriodLabel = cellText(headerRow.getCell(LABEL_COLUMN)) || null;
  const rows = parseRows(worksheet, true);
  return { rawPeriodLabel, rows };
}

/** Lista de PRECIOS DE VENTA ("Lista_Valor_venta_de_SEPxxxx.xlsx", hoja
 * "Precios Grido"). Sólo valida el nombre de hoja como señal estructural
 * (el rótulo de la columna de precio, ej. "PAIS", no es un marcador
 * confirmado como estable entre listas -- sección 9 del prompt: no
 * inventar una validación no evidenciada). */
export async function parseHelacorSalePriceListFile(buffer: Buffer): Promise<ParsedPriceList> {
  const worksheet = await loadWorksheet(buffer, 'Precios Grido');

  const headerRow = worksheet.getRow(HEADER_ROW);
  const rawPeriodLabel = cellText(headerRow.getCell(LABEL_COLUMN)) || null;
  const rows = parseRows(worksheet, false);
  return { rawPeriodLabel, rows };
}
