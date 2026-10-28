/**
 * Parser del reporte "Mix de Ventas" del POS (Etapa 5) -- ver
 * docs/ETAPA-5-IMPORTADOR-VENTAS.md, sección "Archivo real inspeccionado".
 *
 * Fuente real inspeccionada: `apps/api/src/test/fixtures/mixventas-desa-saavedra.xls`
 * (156 filas x 25 columnas, exportado con el filtro "Precios: Desagrupados").
 * Encabezado real, EXACTO y en este orden:
 *   succodigo, grudescrip, artdescrip, cantidad, bultos, preciopromedio,
 *   total, porctotalpesos, kilos, sucursal, sucdescrip, desde, hasta, grupo,
 *   subgrupo, articulo, cajero, promocion, tipooperacion, filtrorubro,
 *   filtrozona, filtrovendedor, filtrocajero, filtrovtaoperacion, filtrocaja
 *
 * `subgrupo` es el discriminador estructural real de qué filas son ventas:
 *   1 = fila de detalle (una venta real) -- la única que se parsea.
 *   2 = subtotal de grupo (ej. "Tops", `artdescrip` vacío) -- se ignora.
 *   3 = total general del archivo (una sola fila, `grudescrip` = "Total
 *       General") -- se ignora como venta, pero su columna `total` es la
 *       fuente de `fileStatedTotal` para la reconciliación (sección 13).
 *
 * `articulo` es el código ESTABLE del producto (nunca `artdescrip`, que
 * cambia según la promoción/Canje aplicado -- ej. "Bombon Crocante en Caja x
 * 8" vs. "Bombon Crocante en Caja x 8 (Canje Especial 2x1 ...)" son el mismo
 * `articulo` = 24 en dos filas separadas).
 *
 * `promocion` es un código numérico: 0 = sin promoción, distinto de 0 = el
 * POS aplicó un precio promocional (delivery, 2x1, Club Grido Canje, etc. --
 * evidencia real: incluye promos de apps de delivery como "Pedi Grido" o
 * "Peya" que NO son Canje). `isCanje` es la señal MÁS ESPECÍFICA: la
 * descripción incluye literalmente la palabra "Canje" -- es el único
 * indicador textual que el propio archivo usa para un canje puntual. Nunca
 * se asume un % fijo de descuento (sección 4 del prompt).
 *
 * El archivo también puede traer filas de descuento/ajuste con `total`
 * NEGATIVO y sin relación con un producto real (ej. grupo "Canjes"/
 * "Descuentos", artículo 1280 "Descuento Pedidosya", -19300) -- son datos
 * reales, no se rechazan como error; como ese código de artículo nunca va a
 * mapearse a un Product real, el mecanismo general de "fila sin mapear nunca
 * impacta stock" ya las neutraliza sin necesitar un caso especial.
 *
 * LIMITACIÓN DOCUMENTADA: la variante "Precios: Agrupados" del mismo reporte
 * comparte EXACTAMENTE el mismo encabezado de 25 columnas (verificado contra
 * `mixventas-agrupado-saavedra.xls`) -- no hay ninguna columna ni marca en el
 * contenido del archivo que permita distinguir con certeza "Agrupados" de
 * "Desagrupados"; la única diferencia observable es que "Agrupados" fusiona
 * las líneas por artículo y pierde el código de promoción/Canje. El parser
 * NO puede rechazar técnicamente un archivo "Agrupados" -- queda como
 * supuesto operativo (el ADMIN debe exportar siempre "Desagrupados"),
 * documentado en docs/ETAPA-5-IMPORTADOR-VENTAS.md, no una validación de
 * software inventada sin evidencia.
 */

import { open as openFile } from 'node:fs/promises';
import xl from 'node-xlrd';
import type { SalesImportRowStatus } from '@sistema-grido/shared-types';

/** Encabezado real y exacto del reporte "Mix de Ventas" (ver cabecera del archivo). */
export const MIX_VENTAS_EXPECTED_HEADERS = [
  'succodigo',
  'grudescrip',
  'artdescrip',
  'cantidad',
  'bultos',
  'preciopromedio',
  'total',
  'porctotalpesos',
  'kilos',
  'sucursal',
  'sucdescrip',
  'desde',
  'hasta',
  'grupo',
  'subgrupo',
  'articulo',
  'cajero',
  'promocion',
  'tipooperacion',
  'filtrorubro',
  'filtrozona',
  'filtrovendedor',
  'filtrocajero',
  'filtrovtaoperacion',
  'filtrocaja',
] as const;

const COLUMN_INDEX = {
  grudescrip: 1,
  artdescrip: 2,
  cantidad: 3,
  bultos: 4,
  preciopromedio: 5,
  total: 6,
  porctotalpesos: 7,
  kilos: 8,
  desde: 11,
  hasta: 12,
  subgrupo: 14,
  articulo: 15,
  promocion: 17,
} as const;

const SUBGRUPO_DETAIL_ROW = 1;
const SUBGRUPO_GRAND_TOTAL_ROW = 3;

export class UnsupportedSalesImportFileError extends Error {}

export interface ParsedMixVentasRow {
  /** Número de fila del archivo original (base 0, incluye el encabezado). */
  rowNumber: number;
  rawArticleCode: string;
  rawDescription: string;
  rawGroup: string;
  /** String decimal (NUMERIC(14,3)). */
  quantity: string;
  /** String decimal (NUMERIC(14,2)) -- puede ser negativo (fila de descuento/ajuste real). */
  amount: string;
  isPromotion: boolean;
  isCanje: boolean;
  promotionCode: string | null;
  unitPriceAvg: string | null;
  bultos: string | null;
  kilos: string | null;
  pctOfTotal: string | null;
  status: SalesImportRowStatus;
  errorMessage: string | null;
}

export interface ParsedMixVentasFile {
  /** Fecha ISO (YYYY-MM-DD) -- columna `desde`, tomada de la primera fila de detalle. */
  periodStart: string;
  /** Fecha ISO (YYYY-MM-DD) -- columna `hasta`, tomada de la primera fila de detalle. */
  periodEnd: string;
  rows: ParsedMixVentasRow[];
  /** String decimal -- columna `total` de la fila "Total General" (subgrupo 3), si existe. */
  fileStatedTotal: string | null;
}

/**
 * Firma OLE2/Compound File Binary (los primeros 8 bytes de todo `.xls`
 * legado real, incluidos ambos archivos reales inspeccionados). `node-xlrd`
 * asume esta firma y, ante un archivo que no la tiene (no es un .xls en
 * absoluto -- ej. un .txt renombrado), puede lanzar una excepción SÍNCRONA
 * dentro de un callback de `fs.read` que escapa de la Promise de abajo
 * (bug real encontrado con un archivo de prueba genuinamente no-OLE2:
 * cuelga el request en vez de rechazar la promesa). Se valida ACÁ, antes de
 * entregarle bytes a `node-xlrd`, para convertir ese caso en un rechazo
 * controlado (`UnsupportedSalesImportFileError`) en vez de una excepción no
 * capturada.
 */
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Lee el archivo `.xls` desde disco y devuelve sus celdas crudas (IO puro, sin validar contenido). */
export async function readXlsFile(
  filePath: string,
): Promise<{ headers: string[]; rows: xl.CellValue[][] }> {
  const handle = await openFile(filePath, 'r');
  let signature: Buffer;
  try {
    const buffer = Buffer.alloc(OLE2_SIGNATURE.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signature = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (!signature.equals(OLE2_SIGNATURE)) {
    throw new UnsupportedSalesImportFileError(
      'El archivo no tiene el formato .xls esperado (no es un archivo de Excel 97-2003 / OLE2 válido).',
    );
  }

  return new Promise((resolve, reject) => {
    xl.open(filePath, (err, workbook) => {
      if (err) {
        reject(err);
        return;
      }
      let sheet;
      try {
        sheet = workbook.sheet.byIndex(0);
      } catch (sheetErr) {
        reject(sheetErr instanceof Error ? sheetErr : new Error(String(sheetErr)));
        return;
      }
      const nrows = sheet.row.count;
      const ncols = sheet.column.count;
      if (nrows === 0 || ncols === 0) {
        reject(new UnsupportedSalesImportFileError('El archivo no tiene filas ni columnas.'));
        return;
      }
      const headers: string[] = [];
      for (let c = 0; c < ncols; c++) {
        headers.push(String(sheet.cell(0, c)));
      }
      const rows: xl.CellValue[][] = [];
      for (let r = 1; r < nrows; r++) {
        const row: xl.CellValue[] = [];
        for (let c = 0; c < ncols; c++) {
          row.push(sheet.cell(r, c));
        }
        rows.push(row);
      }
      resolve({ headers, rows });
    });
  });
}

function isBlank(value: xl.CellValue | undefined): boolean {
  return value === undefined || value === '';
}

/** Convierte una celda numérica (o vacía) a string decimal con la escala pedida, sin arrastrar errores de punto flotante. */
function numberCellToDecimalString(
  value: xl.CellValue | undefined,
  decimals: number,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toFixed(decimals);
}

function dateCellToIsoDate(value: xl.CellValue | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * Valida el encabezado real contra el esperado. No exige ningún tipo de
 * "detección de variante Agrupados/Desagrupados" -- ver limitación
 * documentada en la cabecera del archivo.
 */
export function validateMixVentasHeaders(headers: string[]): boolean {
  if (headers.length !== MIX_VENTAS_EXPECTED_HEADERS.length) return false;
  return MIX_VENTAS_EXPECTED_HEADERS.every((expected, i) => headers[i] === expected);
}

/**
 * Función PURA: recibe las celdas crudas ya leídas (`readXlsFile`) y produce
 * las filas validadas + el período + el total declarado por el archivo. No
 * toca el sistema de archivos ni la base de datos.
 */
export function parseMixVentasRows(
  headers: string[],
  rawRows: xl.CellValue[][],
): ParsedMixVentasFile {
  if (!validateMixVentasHeaders(headers)) {
    throw new UnsupportedSalesImportFileError(
      'El archivo no tiene el encabezado esperado del reporte "Mix de Ventas" ' +
        '(Precios: Desagrupados). Verificá que sea el archivo correcto.',
    );
  }

  const rows: ParsedMixVentasRow[] = [];
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let fileStatedTotal: string | null = null;

  rawRows.forEach((raw, index) => {
    const rowNumber = index + 1; // +1: la fila 0 es el encabezado.
    const subgrupo = raw[COLUMN_INDEX.subgrupo];

    if (subgrupo === SUBGRUPO_GRAND_TOTAL_ROW) {
      fileStatedTotal = numberCellToDecimalString(raw[COLUMN_INDEX.total], 2);
      return;
    }
    if (subgrupo !== SUBGRUPO_DETAIL_ROW) {
      // subgrupo 2 (subtotal de grupo) u otro valor no reconocido -- no es una venta.
      return;
    }

    if (periodStart === null) {
      periodStart = dateCellToIsoDate(raw[COLUMN_INDEX.desde]);
      periodEnd = dateCellToIsoDate(raw[COLUMN_INDEX.hasta]);
    }

    const rawArticleCodeCell = raw[COLUMN_INDEX.articulo];
    const rawArticleCode =
      typeof rawArticleCodeCell === 'number'
        ? String(rawArticleCodeCell)
        : typeof rawArticleCodeCell === 'string'
          ? rawArticleCodeCell
          : '';
    const rawDescriptionCell = raw[COLUMN_INDEX.artdescrip];
    const rawDescription = typeof rawDescriptionCell === 'string' ? rawDescriptionCell : '';
    const rawGroupCell = raw[COLUMN_INDEX.grudescrip];
    const rawGroup = typeof rawGroupCell === 'string' ? rawGroupCell : '';

    const quantity = numberCellToDecimalString(raw[COLUMN_INDEX.cantidad], 3);
    const amount = numberCellToDecimalString(raw[COLUMN_INDEX.total], 2);

    const errors: string[] = [];
    if (isBlank(rawArticleCodeCell) || rawArticleCode === '') {
      errors.push('código de artículo vacío');
    }
    if (rawDescription === '') {
      errors.push('descripción vacía');
    }
    if (quantity === null) {
      errors.push('cantidad inválida');
    } else if (Number(quantity) <= 0) {
      errors.push('cantidad debe ser mayor a cero');
    }
    if (amount === null) {
      errors.push('importe inválido');
    }

    const promocionCell = raw[COLUMN_INDEX.promocion];
    const isPromotion = typeof promocionCell === 'number' && promocionCell !== 0;
    const promotionCode =
      typeof promocionCell === 'number' && promocionCell !== 0 ? String(promocionCell) : null;
    const isCanje = rawDescription.toLowerCase().includes('canje');

    const bultosCell = raw[COLUMN_INDEX.bultos];
    const bultos = typeof bultosCell === 'string' ? bultosCell : null;

    const status: SalesImportRowStatus = errors.length > 0 ? 'ERROR' : 'VALID';

    rows.push({
      rowNumber,
      rawArticleCode,
      rawDescription,
      rawGroup,
      quantity: quantity ?? '0',
      amount: amount ?? '0',
      isPromotion,
      isCanje,
      promotionCode,
      unitPriceAvg: numberCellToDecimalString(raw[COLUMN_INDEX.preciopromedio], 4),
      bultos,
      kilos: numberCellToDecimalString(raw[COLUMN_INDEX.kilos], 3),
      pctOfTotal: numberCellToDecimalString(raw[COLUMN_INDEX.porctotalpesos], 4),
      status,
      errorMessage: errors.length > 0 ? errors.join('; ') : null,
    });
  });

  if (periodStart === null || periodEnd === null) {
    throw new UnsupportedSalesImportFileError(
      'No se pudo determinar el período (columnas "desde"/"hasta") del archivo -- ' +
        'no se encontró ninguna fila de detalle válida.',
    );
  }

  return { periodStart, periodEnd, rows, fileStatedTotal };
}

/** Compone `readXlsFile` + `parseMixVentasRows` -- punto de entrada usado por el servicio de import. */
export async function parseMixVentasFile(filePath: string): Promise<ParsedMixVentasFile> {
  const { headers, rows } = await readXlsFile(filePath);
  return parseMixVentasRows(headers, rows);
}
