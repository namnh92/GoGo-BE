/** One parsed tab: a header row plus its data rows, all cells as raw text. */
export type SheetGrid = {
  name: string;
  headers: string[];
  rows: string[][];
};
