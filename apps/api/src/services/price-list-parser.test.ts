import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseHelacorCostListFile,
  parseHelacorSalePriceListFile,
  UnsupportedPriceListFileError,
} from './price-list-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');
const COST_FIXTURE = path.join(FIXTURES_DIR, 'lista-precio-costo-helacor.xlsx');
const SALE_PRICE_FIXTURE = path.join(FIXTURES_DIR, 'lista-valor-venta-sep2026.xlsx');

/**
 * Tests del parser puro (Etapa 6.2, sección 9 del prompt) contra los DOS
 * archivos reales inspeccionados -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md.
 */
describe('price-list-parser -- "Lista_Precio_Costo.xlsx" (hoja "Precio Helacor")', () => {
  it('parsea las 36 filas de producto reales, ignorando categorías y separadores', async () => {
    const buffer = await readFile(COST_FIXTURE);
    const parsed = await parseHelacorCostListFile(buffer);
    expect(parsed.rows).toHaveLength(36);
    expect(parsed.rows.every((r) => r.status === 'VALID')).toBe(true);
    expect(parsed.rawPeriodLabel).toBe('Septiembre  2026');
  });

  it('primera fila real: SABORES AL AGUA, categoría GRANEL, ambos valores presentes', async () => {
    const buffer = await readFile(COST_FIXTURE);
    const parsed = await parseHelacorCostListFile(buffer);
    const first = parsed.rows[0];
    expect(first?.rowNumber).toBe(4);
    expect(first?.rawLabel).toBe('SABORES AL AGUA');
    expect(first?.rawCategory).toBe('GRANEL');
    expect(first?.rawValueWithoutTax).toBeCloseTo(14367.44, 1);
    expect(first?.rawValueWithTax).toBeCloseTo(17384.6, 1);
  });

  it('usa "Precio C/ IVA" (nunca S/IVA) -- ambos valores difieren y ambos se capturan por separado', async () => {
    const buffer = await readFile(COST_FIXTURE);
    const parsed = await parseHelacorCostListFile(buffer);
    for (const row of parsed.rows) {
      expect(row.rawValueWithTax).not.toBeNull();
      expect(row.rawValueWithTax).toBeGreaterThan(row.rawValueWithoutTax!);
    }
  });

  it('rechaza un archivo sin la hoja "Precio Helacor"', async () => {
    const buffer = await readFile(SALE_PRICE_FIXTURE);
    await expect(parseHelacorCostListFile(buffer)).rejects.toThrow(UnsupportedPriceListFileError);
  });
});

describe('price-list-parser -- "Lista_Valor_venta_de_SEPxxxx.xlsx" (hoja "Precios Grido")', () => {
  it('parsea las 78 filas de producto reales, ignorando categorías, separadores y la fila anómala con sólo un espacio', async () => {
    const buffer = await readFile(SALE_PRICE_FIXTURE);
    const parsed = await parseHelacorSalePriceListFile(buffer);
    expect(parsed.rows).toHaveLength(78);
    expect(parsed.rows.every((r) => r.status === 'VALID')).toBe(true);
    expect(parsed.rows.every((r) => r.rawValueWithoutTax === null)).toBe(true);
  });

  it('primera fila real: CUCURUCHO MINI GIGANTE, categoría "HELADO POR BOCHA / KG.", precio único', async () => {
    const buffer = await readFile(SALE_PRICE_FIXTURE);
    const parsed = await parseHelacorSalePriceListFile(buffer);
    const first = parsed.rows[0];
    expect(first?.rowNumber).toBe(4);
    expect(first?.rawLabel).toBe('CUCURUCHO MINI GIGANTE');
    expect(first?.rawCategory).toBe('HELADO POR BOCHA / KG.');
    expect(first?.rawValueWithTax).toBe(2700);
  });

  it('rechaza un archivo sin la hoja "Precios Grido"', async () => {
    const buffer = await readFile(COST_FIXTURE);
    await expect(parseHelacorSalePriceListFile(buffer)).rejects.toThrow(
      UnsupportedPriceListFileError,
    );
  });
});
