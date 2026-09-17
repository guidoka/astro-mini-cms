// Schreibzugriff des CMS: Formularwerte lesen, Zeilen speichern, Pfade des
// Seitenbaums pflegen. Jede Maske benutzt saveRow mit einer festen
// Spaltenliste, damit nur bekannte Felder in die Datenbank gelangen.
import { pool, query } from './db';
import { cms, CmsError } from './config';

export { CmsError };

/** Slug: Diakritika weg, klein, alles Uebrige zu Bindestrich. */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'seite'
  );
}

export const s = (form: FormData, key: string, max = 2000): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
};
export const sOrNull = (form: FormData, key: string, max = 2000): string | null => s(form, key, max) || null;
export const bool = (form: FormData, key: string): boolean =>
  form.get(key) === 'on' || form.get(key) === 'true' || form.get(key) === '1';
export const int = (form: FormData, key: string, fallback = 0): number => {
  const n = parseInt(s(form, key, 20), 10);
  return Number.isFinite(n) ? n : fallback;
};
export const uuidOrNull = (form: FormData, key: string): string | null => {
  const v = s(form, key, 40);
  return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
};
export const list = (form: FormData, key: string): string[] =>
  form.getAll(key).map(String).map((v) => v.trim()).filter(Boolean);
export const keywords = (form: FormData, key: string): string[] =>
  s(form, key).split(',').map((k) => k.trim()).filter(Boolean);

/** Raster aus dem versteckten JSON-Feld des Editors; ungueltig gibt einen Fehler mit Text. */
export function layoutFromForm(form: FormData) {
  const raw = s(form, 'layout', 5_000_000);
  const { Layout, EMPTY_LAYOUT } = cms().layout;
  if (!raw) return EMPTY_LAYOUT;
  const parsed = Layout.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new CmsError('Inhaltsraster ungültig: ' + parsed.error.issues[0]?.message);
  return parsed.data;
}

/** INSERT oder UPDATE mit fester Spaltenliste. Gibt die id zurueck. */
export async function saveRow(table: string, id: string | null, fields: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(fields);
  const vals = cols.map((c) => {
    const v = fields[c];
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  if (id) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    await query(`UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1}`, [...vals, id]);
    return id;
  }
  const r = await query<{ id: string }>(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  return r[0]!.id;
}

/** Pfade des ganzen Seitenbaums neu berechnen. Kleine Datenmenge, ein Durchlauf. */
export async function recomputePaths(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`
      WITH RECURSIVE tree AS (
        SELECT id, '/'::text AS path FROM pages WHERE parent_id IS NULL
        UNION ALL
        SELECT p.id, t.path || p.slug || '/' FROM pages p JOIN tree t ON p.parent_id = t.id
      )
      UPDATE pages p SET path = t.path FROM tree t
      WHERE p.id = t.id AND p.path IS DISTINCT FROM t.path`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Standardfelder einer Seite aus dem Formular. Das Projekt haengt seine
 * eigenen Spalten an und ruft dann saveRow('pages', …) und recomputePaths().
 * rootHere: diese Seite ist (oder wird) die Startseite ohne Eltern.
 */
export function pageFieldsFromForm(form: FormData, o: { isNew: boolean; rootHere: boolean }): Record<string, unknown> {
  const name = s(form, 'name', 200);
  if (!name) throw new CmsError('Der Name darf nicht leer sein.');
  const parentId = uuidOrNull(form, 'parent_id');
  if (!o.rootHere && !parentId) throw new CmsError('Bitte eine übergeordnete Seite wählen.');
  const slug = o.rootHere ? '' : slugify(s(form, 'slug', 200) || name);
  const kinds = cms().pageKinds;
  const kindRaw = s(form, 'kind', 40);
  const fields: Record<string, unknown> = {
    parent_id: o.rootHere ? null : parentId,
    slug,
    // Der endgueltige Pfad kommt aus recomputePaths; hier nur ein eindeutiger Platzhalter.
    path: o.rootHere ? '/' : `/${slug}-${Date.now()}/`,
    kind: kinds[kindRaw] ? kindRaw : 'standard',
    name,
    title: sOrNull(form, 'title', 300),
    description: sOrNull(form, 'description', 2000),
    meta_title: sOrNull(form, 'meta_title', 300),
    meta_description: sOrNull(form, 'meta_description', 500),
    layout: layoutFromForm(form),
    nav_hide: bool(form, 'nav_hide'),
    sort: int(form, 'sort'),
    published: bool(form, 'published'),
  };
  if (!o.isNew) delete fields.path;
  return fields;
}

/**
 * Datenbankfehler in einen Satz uebersetzen, den die Redaktion versteht.
 * Alles Unbekannte kommt unveraendert durch.
 */
export function readableError(e: unknown): string {
  const err = e as { code?: string; constraint?: string; message?: string; detail?: string };
  if (err?.code === '23505') {
    if (err.constraint?.includes('slug') || err.detail?.includes('slug')) {
      return 'Diese Adresse ist schon vergeben. Bitte im Feld „Adresse“ etwas anderes eintragen.';
    }
    if (err.constraint?.includes('email') || err.detail?.includes('email')) {
      return 'Diese E-Mail-Adresse gibt es schon.';
    }
    return 'Dieser Eintrag ist bereits vorhanden.';
  }
  if (err?.code === '23503') return 'Der Eintrag hängt an anderen Daten und lässt sich so nicht ändern.';
  if (err?.code === '23514') return 'Ein Wert liegt ausserhalb des erlaubten Bereichs.';
  return e instanceof Error ? e.message : String(e);
}

/** Flash-Meldung ueber den Query-String. */
export const flash = (url: URL): { ok?: string; error?: string } => ({
  ok: url.searchParams.get('ok') ?? undefined,
  error: url.searchParams.get('error') ?? undefined,
});
export const withFlash = (path: string, kind: 'ok' | 'error', text: string) =>
  `${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`;
