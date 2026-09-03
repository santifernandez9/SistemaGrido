import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseRow } from './import-catalog.js';

/**
 * Tests del parser puro del importador (Etapa 2, secciones 19-20 del prompt): no
 * tocan la base de datos, sólo el mapping columna->campo y las validaciones que
 * hacen que una fila se salte en vez de importarse a medias.
 */
function buildRow(values: (string | number)[]): ExcelJS.Row {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('PRODUCTOS');
  sheet.addRow([]); // encabezado, ignorado por el test (parseRow no lo lee)
  return sheet.addRow(values);
}

const VALID_ROW = [
  'P001',
  'SABORES AL AGUA',
  'LIMON',
  17212.48,
  0.8,
  'HELADO',
  'SI',
  '',
  'LATA',
  1,
];

describe('import-catalog — parseRow', () => {
  it('parsea una fila válida', () => {
    const result = parseRow(buildRow(VALID_ROW), 2);
    expect(result).toEqual({
      rowNumber: 2,
      code: 'P001',
      categoryName: 'SABORES AL AGUA',
      productName: 'LIMON',
      productTypeCode: 'HELADO',
      active: true,
      unitOfMeasureCode: 'LATA',
      unitsPerHandlingUnit: 1,
    });
  });

  it('normaliza la unidad "UN" a "UNIDAD"', () => {
    const row = [...VALID_ROW];
    row[8] = 'UN';
    const result = parseRow(buildRow(row), 2);
    expect('unitOfMeasureCode' in result && result.unitOfMeasureCode).toBe('UNIDAD');
  });

  it('usa PACK_X = 1 por defecto cuando la celda viene vacía', () => {
    const row = [...VALID_ROW];
    row[9] = '';
    const result = parseRow(buildRow(row), 2);
    expect('unitsPerHandlingUnit' in result && result.unitsPerHandlingUnit).toBe(1);
  });

  it('salta la fila si falta ID o PRODUCTO', () => {
    const row = [...VALID_ROW];
    row[0] = '';
    const result = parseRow(buildRow(row), 5);
    expect(result).toEqual({ row: 5, reason: 'Falta ID o PRODUCTO' });
  });

  it('salta la fila si falta CATEGORIA', () => {
    const row = [...VALID_ROW];
    row[1] = '';
    const result = parseRow(buildRow(row), 6);
    expect(result).toEqual({ row: 6, reason: 'Falta CATEGORIA' });
  });

  it('salta la fila si el tipo (PALLET) no es HELADO ni INSUMO', () => {
    const row = [...VALID_ROW];
    row[5] = 'OTRO';
    const result = parseRow(buildRow(row), 7);
    expect(result).toEqual({ row: 7, reason: 'PALLET (tipo) desconocido: "OTRO"' });
  });

  it('salta la fila si ACTIVO no es SI ni NO', () => {
    const row = [...VALID_ROW];
    row[6] = 'QUIZAS';
    const result = parseRow(buildRow(row), 8);
    expect(result).toEqual({ row: 8, reason: 'ACTIVO desconocido: "QUIZAS"' });
  });

  it('salta la fila si la unidad no es UNIDAD/LATA/CAJA', () => {
    const row = [...VALID_ROW];
    row[8] = 'KILO';
    const result = parseRow(buildRow(row), 9);
    expect(result).toEqual({ row: 9, reason: 'UNIDAD desconocida: "KILO"' });
  });

  it('salta la fila si PACK_X no es un entero positivo', () => {
    const row = [...VALID_ROW];
    row[9] = -3;
    const result = parseRow(buildRow(row), 10);
    expect(result).toEqual({ row: 10, reason: 'PACK_X inválido: "-3"' });
  });
});
