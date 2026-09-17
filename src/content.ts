// Lesezugriff auf den Seitenbaum fuer die oeffentliche Seite. Schreibzugriff
// steht in admin.ts.
import { one, query } from './db';
import { cms } from './config';

export interface NavItem {
  name: string;
  path: string;
  children: NavItem[];
}

export interface PageBase {
  id: string;
  parent_id: string | null;
  slug: string;
  path: string;
  kind: string;
  name: string;
  title: string | null;
  description: string | null;
  meta_title: string | null;
  meta_description: string | null;
  nav_hide: boolean;
  sort: number;
  published: boolean;
}

/** Pfade sind klein geschrieben und haben vorne und hinten einen Slash. */
export const normalizePath = (p: string): string => {
  let s = p.split('?')[0] ?? '/';
  if (!s.startsWith('/')) s = '/' + s;
  if (!s.endsWith('/')) s += '/';
  return s.toLowerCase();
};

/** Hauptmenue: sichtbare Kinder der Startseite, darunter deren sichtbare Kinder. */
export async function getNav(): Promise<NavItem[]> {
  const pages = await query<Pick<PageBase, 'id' | 'parent_id' | 'name' | 'path' | 'nav_hide' | 'sort'>>(
    `SELECT id, parent_id, name, path, nav_hide, sort FROM pages WHERE published ORDER BY sort, name`,
  );
  const home = pages.find((p) => p.parent_id === null);
  if (!home) return [];
  const childrenOf = (id: string): NavItem[] =>
    pages.filter((p) => p.parent_id === id && !p.nav_hide).map((p) => ({ name: p.name, path: p.path, children: [] }));
  return pages
    .filter((p) => p.parent_id === home.id && !p.nav_hide)
    .map((p) => ({ name: p.name, path: p.path, children: childrenOf(p.id) }));
}

/**
 * Veroeffentlichte Seite zu einem Pfad, alle Spalten, das Raster geprueft.
 * Der Typparameter beschreibt die zusaetzlichen Spalten des Projekts.
 */
export async function getPage<T extends Record<string, unknown> = Record<string, never>>(
  rawPath: string,
): Promise<(PageBase & T & { layout: ReturnType<typeof cms>['layout']['EMPTY_LAYOUT'] }) | null> {
  const path = normalizePath(rawPath);
  const row = await one<PageBase & T & { layout: unknown }>(
    `SELECT p.* FROM pages p WHERE p.path = $1 AND p.published`,
    [path],
  );
  if (!row) return null;
  return { ...row, layout: cms().layout.parseLayout(row.layout) };
}

/** Elternkette fuer die Brotkrumen, Startseite zuerst, ohne die Seite selbst. */
export async function ancestors(path: string): Promise<{ name: string; path: string }[]> {
  const parts = normalizePath(path).split('/').filter(Boolean);
  const paths = ['/', ...parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/') + '/')].slice(0, -1);
  if (!paths.length) return [];
  const rows = await query<{ name: string; path: string }>(
    `SELECT name, path FROM pages WHERE path = ANY($1) AND published`,
    [paths],
  );
  return paths.map((p) => rows.find((r) => r.path === p)).filter((r): r is { name: string; path: string } => !!r);
}
