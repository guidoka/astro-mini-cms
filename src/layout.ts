// Inhaltsraster als JSON: Zeilen mit Spalten, darin Bloecke. Das CMS
// bearbeitet es im Browser (editor/admin.js), das Projekt rendert es.
// Drei Blocktypen bringt das Paket mit (Text, Bild, Bildergalerie); was ein
// Projekt darueber hinaus braucht, kommt als eigenes Schema dazu, nicht als
// HTML-Bastelei im Text.
import { z } from 'zod';

export const DEFAULT_ROW_LAYOUTS = {
  voll: [12],
  halbe_halbe: [6, 6],
  drittel: [4, 4, 4],
  viertel: [3, 3, 3, 3],
  zweidrittel_rest: [8, 4],
  eindrittel_rest: [4, 8],
} as const;

export const DEFAULT_ROW_NAMES: Record<string, string> = {
  voll: 'Voll',
  halbe_halbe: 'Halbe / Halbe',
  drittel: 'Drittel',
  viertel: 'Viertel',
  zweidrittel_rest: 'Zweidrittel / Rest',
  eindrittel_rest: 'Eindrittel / Rest',
  dreiviertel_rest: 'Dreiviertel / Rest',
  einviertel_rest: 'Einviertel / Rest',
};

/** Rich-Text aus dem Editor. */
export const RteBlock = z.object({ type: z.literal('rte'), html: z.string() });

export const ImageBlock = z.object({
  type: z.literal('image'),
  file_id: z.uuid().nullable(),
  src: z.string(),
  alt: z.string().default(''),
  caption: z.string().optional(),
});

export const SliderBlock = z.object({
  type: z.literal('slider'),
  items: z.array(
    z.object({
      file_id: z.uuid().nullable(),
      src: z.string(),
      title: z.string().default(''),
      html: z.string().default(''),
    }),
  ),
});

type AnyBlockSchema = z.ZodObject<{ type: z.ZodLiteral<string> } & z.ZodRawShape>;

export interface LayoutOptions<B extends readonly AnyBlockSchema[]> {
  /** Zeilenmuster: Schluessel → Spaltenbreiten (Summe 12). */
  rowLayouts?: Record<string, readonly number[]>;
  /** Bezeichnungen der Zeilenmuster in der Oberflaeche. */
  rowNames?: Record<string, string>;
  /**
   * Weitere Blocktypen, je ein z.object mit type: z.literal('…'). Ein Block
   * mit dem Typ eines Kernblocks (rte, image, slider) ersetzt diesen, etwa
   * ein Bildblock mit zusaetzlichen Feldern.
   */
  blocks?: B;
}

const blockType = (s: AnyBlockSchema): string => String((s.shape.type as z.ZodLiteral<string>).value);

type CoreBlock = z.infer<typeof RteBlock> | z.infer<typeof ImageBlock> | z.infer<typeof SliderBlock>;
type ExtraBlock<B extends readonly AnyBlockSchema[]> = z.infer<B[number]>;
/** Kernbloecke ohne die, die das Projekt mit demselben Typ ersetzt, plus die des Projekts. */
type BlockOf<B extends readonly AnyBlockSchema[]> = Exclude<CoreBlock, { type: ExtraBlock<B>['type'] }> | ExtraBlock<B>;

/**
 * Raster-Schema fuer ein Projekt bauen. Gibt Schemas, Typen-Helfer und die
 * Angaben zurueck, die der Editor braucht.
 */
export function defineLayout<const B extends readonly AnyBlockSchema[] = readonly []>(
  opts: LayoutOptions<B> = {},
) {
  const ROW_LAYOUTS: Record<string, readonly number[]> = opts.rowLayouts ?? DEFAULT_ROW_LAYOUTS;
  const rowNames: Record<string, string> = { ...DEFAULT_ROW_NAMES, ...opts.rowNames };
  const keys = Object.keys(ROW_LAYOUTS) as [string, ...string[]];
  if (!keys.length) throw new Error('Mindestens ein Zeilenmuster ist noetig.');

  const extra = (opts.blocks ?? []) as unknown as B;
  const overridden = new Set(extra.map(blockType));
  const core = [RteBlock, ImageBlock, SliderBlock].filter((b) => !overridden.has(blockType(b)));
  const Block = z.discriminatedUnion(
    'type',
    [...core, ...extra] as unknown as readonly [AnyBlockSchema, ...AnyBlockSchema[]],
  ) as unknown as z.ZodType<BlockOf<B>>;
  const Column = z.object({
    span: z.number().int().min(1).max(12),
    blocks: z.array(Block),
  });
  const Row = z.object({
    layout: z.enum(keys),
    columns: z.array(Column),
  });
  const Layout = z.object({ rows: z.array(Row) });
  type Layout = z.infer<typeof Layout>;

  const EMPTY_LAYOUT: Layout = { rows: [] };

  /** Aus der Datenbank gelesenes Raster pruefen; kaputte Daten kippen die Seite nicht. */
  const parseLayout = (value: unknown): Layout => {
    const parsed = Layout.safeParse(value);
    return parsed.success ? parsed.data : EMPTY_LAYOUT;
  };

  return { ROW_LAYOUTS, rowNames, Block, Column, Row, Layout, EMPTY_LAYOUT, parseLayout };
}

export type LayoutDef = ReturnType<typeof defineLayout<readonly AnyBlockSchema[]>>;
