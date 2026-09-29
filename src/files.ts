// Medienbibliothek: Bilder und PDFs der Seite. Die Datei liegt in der
// konfigurierten Ablage, die Zeile in files; blob_key ist direkt als src
// verwendbar (Pfad oder URL).
import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { one, query } from './db';
import { cms, CmsError, type FileUse } from './config';
import { slugify } from './admin';

export type { FileUse };

export interface FileRow {
  id: string;
  blob_key: string;
  filename: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  title: string | null;
  folder: string | null;
}

/** Suche ueber Dateiname und Bezeichnung, wahlweise auf einen Ordner begrenzt, seitenweise. */
export const listFiles = (q = '', limit = 60, offset = 0, folder = '') =>
  query<FileRow>(
    `SELECT id, blob_key, filename, mime, width, height, title, folder FROM files
     WHERE ($1 = '' OR filename ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%')
       AND ($4 = '' OR folder = $4)
     ORDER BY created_at DESC, filename LIMIT $2 OFFSET $3`,
    [q, limit, offset, folder],
  );

export const countFiles = async (q = '', folder = ''): Promise<number> => {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM files
     WHERE ($1 = '' OR filename ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%')
       AND ($2 = '' OR folder = $2)`,
    [q, folder],
  );
  return r?.n ?? 0;
};

export interface FolderRow {
  id: string;
  name: string;
  n: number;
}

/** Ordner mit Dateianzahl, inklusive leerer Ordner aus file_folders. */
export const fileFolders = () =>
  query<FolderRow>(
    `SELECT ff.id, ff.name, count(f.id)::int AS n
     FROM file_folders ff LEFT JOIN files f ON f.folder = ff.name
     GROUP BY ff.id, ff.name ORDER BY ff.name`,
  );

/** Ordner anlegen. Gibt die neue Zeile zurueck. */
export async function createFolder(name: string): Promise<FolderRow> {
  name = name.trim();
  if (!name) throw new CmsError('Ordnername darf nicht leer sein.');
  const r = await query<FolderRow>(
    `INSERT INTO file_folders (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = $1
     RETURNING id, name, 0 AS n`,
    [name],
  );
  return r[0]!;
}

/** Ordner umbenennen und alle Dateien darin nachziehen. */
export async function renameFolder(id: string, newName: string): Promise<void> {
  newName = newName.trim();
  if (!newName) throw new CmsError('Ordnername darf nicht leer sein.');
  const old = await one<{ name: string }>(`SELECT name FROM file_folders WHERE id = $1`, [id]);
  if (!old) throw new CmsError('Ordner nicht gefunden.');
  await query(`UPDATE file_folders SET name = $1 WHERE id = $2`, [newName, id]);
  await query(`UPDATE files SET folder = $1 WHERE folder = $2`, [newName, old.name]);
}

/** Alle Dateien eines Ordners in einen anderen verschieben. */
export async function moveAllFiles(fromId: string, toId: string): Promise<number> {
  const from = await one<{ name: string }>(`SELECT name FROM file_folders WHERE id = $1`, [fromId]);
  const to = await one<{ name: string }>(`SELECT name FROM file_folders WHERE id = $1`, [toId]);
  if (!from || !to) throw new CmsError('Ordner nicht gefunden.');
  const r = await query<{ n: number }>(`WITH u AS (UPDATE files SET folder = $1 WHERE folder = $2 RETURNING 1) SELECT count(*)::int AS n FROM u`, [to.name, from.name]);
  return r[0]?.n ?? 0;
}

/** Leeren Ordner loeschen. Wirft, wenn noch Dateien drin sind. */
export async function deleteFolder(id: string): Promise<void> {
  const f = await one<{ name: string }>(`SELECT name FROM file_folders WHERE id = $1`, [id]);
  if (!f) throw new CmsError('Ordner nicht gefunden.');
  const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM files WHERE folder = $1`, [f.name]);
  if (n && n.n > 0) throw new CmsError(`Der Ordner enthält noch ${n.n} Datei(en). Erst verschieben.`);
  await query(`DELETE FROM file_folders WHERE id = $1`, [id]);
}

/** Ordner einer einzelnen Datei aendern. */
export async function moveFile(fileId: string, folderName: string): Promise<void> {
  await query(`UPDATE files SET folder = $1 WHERE id = $2`, [folderName || null, fileId]);
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export const UPLOAD_ACCEPT = Object.keys(MIME).join(',');

/** Datei ablegen und Zeile in files anlegen. Der Ordner ist zufaellig, damit sich Namen nie stossen. */
export async function storeUpload(file: File, title?: string, folder = 'Upload'): Promise<FileRow> {
  const ext = extname(file.name).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new CmsError('Dateityp nicht erlaubt: ' + (ext || 'ohne Endung'));
  const max = cms().maxUploadBytes;
  if (file.size > max) throw new CmsError(`Datei grösser als ${Math.round(max / 1024 / 1024)} MB`);
  const dir = randomBytes(4).toString('hex');
  const base = slugify(file.name.slice(0, -ext.length)) || 'datei';
  const name = `${base}${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const blobKey = await cms().storage.put(`media/${dir}/${name}`, bytes, mime);
  const r = await query<FileRow>(
    `INSERT INTO files (blob_key, filename, mime, size, title, folder)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, blob_key, filename, mime, width, height, title, folder`,
    [blobKey, name, mime, file.size, title || file.name, folder],
  );
  return r[0]!;
}

/**
 * Wo eine Datei verwendet wird: das Raster der Seiten und das Logo, dazu die
 * Stellen des Projekts (configureCms fileUsage): eigene Tabellen, feste
 * Bildfelder, Rich-Text-Spalten. byPath und byId sind LIKE-Muster.
 */
export async function fileUsage(id: string): Promise<FileUse[]> {
  const f = await one<{ blob_key: string }>(`SELECT blob_key FROM files WHERE id = $1`, [id]);
  if (!f) return [];
  const byPath = '%' + f.blob_key + '%';
  const byId = '%' + id + '%';
  const base = await query<FileUse>(
    `SELECT 'Seite' AS kind, name, '/admin/seiten/' || id AS href FROM pages
       WHERE layout::text LIKE $1 OR layout::text LIKE $2
     UNION ALL SELECT 'Einstellungen', 'Logo', '/admin/einstellungen'
       FROM site_settings WHERE logo_id = $3`,
    [byPath, byId, id],
  );
  const extra = cms().fileUsage ? await cms().fileUsage!({ id, byPath, byId }) : [];
  return [...base, ...extra].sort((a, b) => a.kind.localeCompare(b.kind, 'de') || a.name.localeCompare(b.name, 'de'));
}

/** Datei loeschen, nur wenn sie nirgends verwendet wird. */
export async function deleteFile(id: string): Promise<void> {
  const uses = await fileUsage(id);
  if (uses.length) {
    const shown = uses.slice(0, 5).map((u) => `${u.kind} „${u.name}“`).join(', ');
    throw new CmsError(
      `Datei wird noch verwendet: ${shown}${uses.length > 5 ? ` und ${uses.length - 5} weitere` : ''}. Dort zuerst entfernen.`,
    );
  }
  const f = await one<{ blob_key: string }>(`SELECT blob_key FROM files WHERE id = $1`, [id]);
  if (!f) throw new CmsError('Datei nicht gefunden');
  await query(`DELETE FROM files WHERE id = $1`, [id]);
  await cms().storage.remove(f.blob_key);
}

export const fileSrc = async (id: string | null): Promise<string | null> =>
  id ? ((await one<{ blob_key: string }>(`SELECT blob_key FROM files WHERE id = $1`, [id]))?.blob_key ?? null) : null;
