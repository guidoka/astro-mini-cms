// Serverseitige Logik der mitgelieferten Seiten. Je Seite eine Funktion,
// die POST verarbeitet und die Daten fuer die zugehoerige View liefert:
//
//   const p = await filesPage(Astro);
//   if (p.redirect) return Astro.redirect(p.redirect, 302);
//   <Admin title="Dateien" ok={p.ok} error={p.error}><FilesView {...p} /></Admin>
import type { APIContext, AstroCookies } from 'astro';
import { query } from './db';
import { cms, CmsError } from './config';
import { flash, readableError, withFlash } from './admin';
import { countFiles, createFolder, deleteFile, deleteFolder, fileFolders, fileUsage, listFiles, moveAllFiles, moveFile, renameFolder, storeUpload, type FileRow, type FileUse, type FolderRow } from './files';
import { requestCode, sessionHours, setSessionCookie, userFromCookies, verifyCode, type CmsUser } from './auth';

type Ctx = Pick<APIContext, 'request' | 'url' | 'cookies' | 'locals'>;

// ---- Dateien ---------------------------------------------------------------

export interface FilesPageData {
  redirect?: string;
  ok?: string;
  error?: string;
  basePath: string;
  q: string;
  folder: string;
  page: number;
  pages: number;
  total: number;
  files: FileRow[];
  folders: FolderRow[];
  usageId: string | null;
  usage: FileUse[];
}

export async function filesPage(Astro: Ctx, opts: { basePath?: string; pageSize?: number } = {}): Promise<FilesPageData> {
  const basePath = opts.basePath ?? '/admin/dateien';
  const pageSize = opts.pageSize ?? 60;
  let error = '';

  if (Astro.request.method === 'POST') {
    const form = await Astro.request.formData();
    const action = String(form.get('_action') ?? '');
    try {
      if (action === 'delete') {
        await deleteFile(String(form.get('id') ?? ''));
        return { redirect: withFlash(basePath, 'ok', 'Datei gelöscht.') } as FilesPageData;
      }
      if (action === 'move') {
        await moveFile(String(form.get('id') ?? ''), String(form.get('folder') ?? ''));
        return { redirect: withFlash(basePath, 'ok', 'Datei verschoben.') } as FilesPageData;
      }
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) throw new CmsError('Bitte eine Datei wählen.');
      const uploadFolder = String(form.get('folder') ?? '') || 'Upload';
      await storeUpload(file, String(form.get('title') ?? '') || undefined, uploadFolder);
      return { redirect: withFlash(basePath, 'ok', 'Datei hochgeladen.') } as FilesPageData;
    } catch (e) {
      error = readableError(e);
    }
  }

  const q = Astro.url.searchParams.get('q') ?? '';
  const folder = Astro.url.searchParams.get('ordner') ?? '';
  const page = Math.max(1, parseInt(Astro.url.searchParams.get('seite') ?? '1', 10) || 1);
  const [files, total, folders] = await Promise.all([
    listFiles(q, pageSize, (page - 1) * pageSize, folder),
    countFiles(q, folder),
    fileFolders(),
  ]);
  const usageId = Astro.url.searchParams.get('verwendung');
  const usage = usageId ? await fileUsage(usageId) : [];
  const f = flash(Astro.url);
  return {
    ok: f.ok,
    error: error || f.error,
    basePath, q, folder, page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    total, files, folders, usageId, usage,
  };
}

// ---- Ordnerverwaltung ------------------------------------------------------

export interface FoldersPageData {
  redirect?: string;
  ok?: string;
  error?: string;
  folders: FolderRow[];
  filesBasePath: string;
}

export async function foldersPage(Astro: Ctx, opts: { basePath?: string; filesBasePath?: string } = {}): Promise<FoldersPageData> {
  const basePath = opts.basePath ?? '/admin/dateien/ordner';
  const filesBasePath = opts.filesBasePath ?? '/admin/dateien';
  let error = '';

  if (Astro.request.method === 'POST') {
    const form = await Astro.request.formData();
    const action = String(form.get('_action') ?? '');
    try {
      if (action === 'add') {
        await createFolder(String(form.get('name') ?? ''));
        return { redirect: withFlash(basePath, 'ok', 'Ordner angelegt.') } as FoldersPageData;
      }
      if (action === 'rename') {
        await renameFolder(String(form.get('id') ?? ''), String(form.get('name') ?? ''));
        return { redirect: withFlash(basePath, 'ok', 'Ordner umbenannt.') } as FoldersPageData;
      }
      if (action === 'move_all') {
        const n = await moveAllFiles(String(form.get('from') ?? ''), String(form.get('to') ?? ''));
        return { redirect: withFlash(basePath, 'ok', `${n} Datei(en) verschoben.`) } as FoldersPageData;
      }
      if (action === 'delete') {
        await deleteFolder(String(form.get('id') ?? ''));
        return { redirect: withFlash(basePath, 'ok', 'Ordner gelöscht.') } as FoldersPageData;
      }
    } catch (e) {
      error = readableError(e);
    }
  }

  const f = flash(Astro.url);
  const folders = await fileFolders();
  return { ok: f.ok, error: error || f.error, folders, filesBasePath };
}

// ---- Seitenbaum ------------------------------------------------------------

export interface PageTreeRow {
  id: string;
  name: string;
  path: string;
  kind: string;
  published: boolean;
  nav_hide: boolean;
  depth: number;
}

export async function pagesIndex(Astro: Pick<Ctx, 'url'>): Promise<{ ok?: string; error?: string; rows: PageTreeRow[]; kinds: Record<string, string> }> {
  // Reihenfolge wie im Menue: Baum, darin nach sort. Vorher nach path, das sah
  // nur richtig aus, solange die Adressen nummeriert waren (24.09.2026).
  const rows = await query<PageTreeRow>(
    `WITH RECURSIVE tree AS (
       SELECT id, name, path, kind, published, nav_hide, 0 AS depth,
              ARRAY[sort]::int[] AS ord, ARRAY[name]::text[] AS ordname
       FROM pages WHERE parent_id IS NULL
       UNION ALL
       SELECT p.id, p.name, p.path, p.kind, p.published, p.nav_hide, t.depth + 1,
              t.ord || p.sort, t.ordname || p.name
       FROM pages p JOIN tree t ON p.parent_id = t.id
     )
     SELECT id, name, path, kind, published, nav_hide, depth FROM tree ORDER BY ord, ordname`,
  );
  return { ...flash(Astro.url), rows, kinds: cms().pageKinds };
}

// ---- Anmeldung -------------------------------------------------------------

export interface LoginOptions {
  /** Wer nach dem Anmelden in die Pflegeoberflaeche darf; Vorgabe: jeder Angemeldete. */
  allow?: (user: CmsUser | null) => boolean;
  /** Pfad der Pflegeoberflaeche; ?next= darf nur dorthin zeigen. */
  adminPrefix?: string;
  /** Wohin, wenn jemand angemeldet ist, aber nicht hinein darf. */
  fallback?: string;
  /** Haken „angemeldet bleiben“ anbieten. */
  remember?: boolean;
}

export interface LoginPageData {
  redirect?: string;
  step: 'email' | 'code';
  email: string;
  remember: boolean;
  error: string;
  /** Tage, die die lange Sitzung haelt (fuer den Hakentext). */
  days: number;
  showRemember: boolean;
}

export async function loginPage(Astro: Ctx, opts: LoginOptions = {}): Promise<LoginPageData> {
  const prefix = (opts.adminPrefix ?? '/admin').replace(/\/+$/, '');
  const allow = opts.allow ?? ((u) => !!u);
  const fallback = opts.fallback ?? '/';
  const showRemember = opts.remember ?? true;
  const nextRaw = Astro.url.searchParams.get('next') || prefix;
  const next = nextRaw.startsWith(prefix) && !nextRaw.startsWith('//') ? nextRaw : prefix;
  const days = Math.round(sessionHours(true) / 24);

  const current = (Astro.locals as { user?: CmsUser | null }).user ?? null;
  if (allow(current)) return { redirect: next, step: 'email', email: '', remember: false, error: '', days, showRemember };

  let step: 'email' | 'code' = 'email';
  let email = '';
  let remember = false;
  let error = '';

  if (Astro.request.method === 'POST') {
    const form = await Astro.request.formData();
    email = String(form.get('email') ?? '').trim().toLowerCase();
    remember = showRemember && form.get('merken') === 'on';

    if (form.get('step') === 'code') {
      const code = form.getAll('ziffer').map(String).join('') || String(form.get('code') ?? '');
      const token = await verifyCode(email, code, remember);
      if (token) {
        setSessionCookie(Astro.cookies as AstroCookies, token, Astro.request, sessionHours(remember));
        const user = await userFromCookies(Astro.cookies as AstroCookies);
        return { redirect: allow(user) ? next : fallback, step, email, remember, error, days, showRemember };
      }
      error = 'Code falsch oder abgelaufen. Bitte neu anfordern.';
      step = 'code';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      error = 'Bitte eine gültige E-Mail-Adresse eingeben.';
    } else {
      try {
        await requestCode(email);
        step = 'code';
      } catch (e) {
        console.error('[cms] Anmeldecode', e);
        error = e instanceof CmsError ? e.message : 'Der Code konnte nicht gesendet werden.';
      }
    }
  }
  return { step, email, remember, error, days, showRemember };
}
