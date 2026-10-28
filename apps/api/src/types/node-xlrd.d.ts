/**
 * Declaración ambiente mínima de `node-xlrd` (Etapa 5) -- el paquete no
 * publica tipos propios ni existe un paquete `@types/node-xlrd`. Sólo se
 * tipa la superficie que el importador de ventas usa realmente
 * (ver apps/api/src/services/sales-import-parser.ts): abrir un archivo
 * `.xls` desde disco y leer celdas de la primera hoja.
 */
declare module 'node-xlrd' {
  export type CellValue = string | number | Date;

  export interface Sheet {
    readonly name: string;
    row: {
      readonly count: number;
    };
    column: {
      readonly count: number;
    };
    cell(rowIndex: number, colIndex: number): CellValue;
  }

  export interface Workbook {
    sheet: {
      byIndex(index: number): Sheet;
    };
  }

  export function open(
    fileName: string,
    callback: (err: Error | null, workbook: Workbook) => void,
  ): void;
}
