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
import { countFiles, deleteFile, fileFolders, fileUsage, listFiles, storeUpload, type FileRow, type FileUse } from './files';
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
  folders: { folder: string; n: number }[];
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
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) throw new CmsError('Bitte eine Datei wählen.');
      await storeUpload(file, String(form.get('title') ?? '') || undefined);
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
  const rows = await query<PageTreeRow>(
    `SELECT id, name, path, kind, published, nav_hide,
            length(path) - length(replace(path, '/', '')) - 1 AS depth
     FROM pages ORDER BY path`,
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
