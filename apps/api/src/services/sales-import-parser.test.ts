import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMixVentasFile,
  parseMixVentasRows,
  readXlsFile,
  UnsupportedSalesImportFileError,
  validateMixVentasHeaders,
  MIX_VENTAS_EXPECTED_HEADERS,
} from './sales-import-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');
const DESAGRUPADO_FIXTURE = path.join(FIXTURES_DIR, 'mixventas-desa-saavedra.xls');
const AGRUPADO_FIXTURE = path.join(FIXTURES_DIR, 'mixventas-agrupado-saavedra.xls');

describe('sales-import-parser -- archivo real "Mix de Ventas" (Desagrupado)', () => {
  it('parsea el archivo real y reconoce las columnas reales', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);

    expect(parsed.periodStart).toBe('2026-08-10');
    expect(parsed.periodEnd).toBe('2026-08-20');
    // 156 filas totales - 1 encabezado - 18 subtotales de grupo (subgrupo=2) - 1 total general (subgrupo=3) = 136.
    expect(parsed.rows).toHaveLength(136);
    expect(parsed.fileStatedTotal).toBe('11778196.68');
  });

  it('interpreta valores numéricos reales (cantidad, importe) correctamente', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    const first = parsed.rows[0];
    expect(first).toBeDefined();
    expect(first?.rawArticleCode).toBe('4272');
    expect(first?.rawDescription).toBe('Alfajor Secreto Cookies And Cream');
    expect(first?.rawGroup).toBe('Bombones');
    expect(first?.quantity).toBe('14.000');
    expect(first?.amount).toBe('190400.00');
    expect(first?.status).toBe('VALID');
    expect(first?.errorMessage).toBeNull();
  });

  it('detecta promoción y Canje a partir de evidencia real (código promocion + texto "Canje")', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    const canjeRow = parsed.rows.find((r) =>
      r.rawDescription.includes('Bombon Crocante en Caja x 8 (Canje Especial 2x1'),
    );
    expect(canjeRow).toBeDefined();
    expect(canjeRow?.isPromotion).toBe(true);
    expect(canjeRow?.isCanje).toBe(true);
    expect(canjeRow?.promotionCode).toBe('4698');
    expect(canjeRow?.rawArticleCode).toBe('24');

    // La fila normal (sin Canje) del mismo artículo 24 no debe marcarse.
    const normalRow = parsed.rows.find(
      (r) => r.rawArticleCode === '24' && !r.rawDescription.includes('Canje'),
    );
    expect(normalRow).toBeDefined();
    expect(normalRow?.isPromotion).toBe(false);
    expect(normalRow?.isCanje).toBe(false);
    expect(normalRow?.promotionCode).toBeNull();
  });

  it('detecta promoción genérica (delivery apps) sin marcarla como Canje', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    const deliveryPromoRow = parsed.rows.find((r) => r.rawDescription.includes('Pedi Grido'));
    expect(deliveryPromoRow).toBeDefined();
    expect(deliveryPromoRow?.isPromotion).toBe(true);
    expect(deliveryPromoRow?.isCanje).toBe(false);
  });

  it('acepta importes negativos reales (filas de descuento/ajuste, ej. "Descuento Pedidosya")', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    const discountRow = parsed.rows.find((r) => r.rawDescription === 'Descuento Pedidosya');
    expect(discountRow).toBeDefined();
    expect(discountRow?.status).toBe('VALID');
    expect(Number(discountRow?.amount)).toBeLessThan(0);
  });

  it('ignora filas de subtotal de grupo (subgrupo=2) y de total general (subgrupo=3)', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    expect(parsed.rows.some((r) => r.rawDescription === '')).toBe(false);
    expect(parsed.rows.some((r) => r.rawGroup === 'Total General')).toBe(false);
  });

  it('la suma de importes de filas válidas reconcilia contra el total declarado por el archivo', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    const sum = parsed.rows.reduce((acc, r) => acc + Number(r.amount), 0);
    expect(Math.round(sum * 100) / 100).toBeCloseTo(Number(parsed.fileStatedTotal), 2);
  });

  it('bultos "N/A" (filas de descuento sin presentación) se guarda como string, no rompe el parseo', async () => {
    const parsed = await parseMixVentasFile(DESAGRUPADO_FIXTURE);
    const discountRow = parsed.rows.find((r) => r.rawDescription === 'Descuento Pedidosya');
    expect(discountRow?.bultos).toBe('N/A');
  });
});

describe('sales-import-parser -- validación de formato', () => {
  it('rechaza un archivo sin el encabezado esperado', () => {
    expect(validateMixVentasHeaders(['otra', 'cosa'])).toBe(false);
    expect(validateMixVentasHeaders([...MIX_VENTAS_EXPECTED_HEADERS])).toBe(true);
  });

  it('parseMixVentasRows lanza UnsupportedSalesImportFileError con encabezado inválido', () => {
    expect(() => parseMixVentasRows(['a', 'b'], [])).toThrow(UnsupportedSalesImportFileError);
  });

  it('documenta la limitación real: la variante Agrupada comparte el mismo encabezado y por eso se parsea igual, perdiendo la señal de Canje', async () => {
    // La variante "Agrupados" del mismo reporte NO tiene ninguna columna ni marca que la
    // distinga de "Desagrupados" -- comparten el encabezado exacto (ver cabecera del
    // archivo del parser). El parser no puede rechazarla por contenido sin inventar una
    // regla no respaldada por evidencia; este test documenta la consecuencia real: se
    // parsea igual, pero pierde por completo la señal de Canje (0 filas con isCanje=true).
    const parsed = await parseMixVentasFile(AGRUPADO_FIXTURE);
    expect(parsed.rows.every((r) => !r.isCanje)).toBe(true);
  });
});

describe('sales-import-parser -- readXlsFile (IO)', () => {
  it('lee encabezados y filas crudas del archivo real', async () => {
    const { headers, rows } = await readXlsFile(DESAGRUPADO_FIXTURE);
    expect(headers).toEqual([...MIX_VENTAS_EXPECTED_HEADERS]);
    expect(rows).toHaveLength(155);
  });

  it('rechaza una ruta de archivo inexistente', async () => {
    await expect(readXlsFile(path.join(FIXTURES_DIR, 'no-existe.xls'))).rejects.toThrow();
  });
});
