// Fertige Endpunkte fuer die Pflegeoberflaeche. Das Projekt legt je eine
// Datei an und exportiert das Ergebnis:
//   src/pages/admin/api/dateien.ts   export const GET = filesListRoute();
//   src/pages/admin/api/upload.ts    export const POST = uploadRoute();
//   src/pages/abmelden.ts            export const POST = logoutRoute('/');
// Die Pfade /admin/api/dateien und /admin/api/upload sind im Editor fest.
import type { APIRoute } from 'astro';
import { countFiles, fileFolders, listFiles, storeUpload } from './files';
import { logout } from './auth';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** Dateiliste fuer die Bildauswahl: Suche und Ordnerfilter, hoechstens `limit` Treffer. */
export function filesListRoute(limit = 200): APIRoute {
  return async ({ url, locals }) => {
    if (!(locals as { user?: unknown }).user) return json({ files: [], folders: [], total: 0 }, 401);
    const q = url.searchParams.get('q') ?? '';
    const folder = url.searchParams.get('ordner') ?? '';
    const [files, total, folders] = await Promise.all([listFiles(q, limit, 0, folder), countFiles(q, folder), fileFolders()]);
    return json({
      total,
      folders: folders.map((f) => ({ name: f.folder, n: f.n })),
      files: files.map((f) => ({
        id: f.id, src: f.blob_key, filename: f.filename, mime: f.mime, title: f.title, folder: f.folder,
      })),
    });
  };
}

/** Hochladen aus dem Editor heraus, ohne die Maske zu verlassen. */
export function uploadRoute(): APIRoute {
  return async ({ request, locals }) => {
    if (!(locals as { user?: unknown }).user) return json({ error: 'nicht angemeldet' }, 401);
    try {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('Keine Datei');
      const f = await storeUpload(file, String(form.get('title') ?? ''));
      return json({ id: f.id, src: f.blob_key, filename: f.filename, mime: f.mime, title: f.title });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Hochladen fehlgeschlagen' }, 400);
    }
  };
}

/** Abmelden: Sitzung loeschen, Cookie entfernen, weiterleiten. */
export function logoutRoute(redirectTo = '/'): APIRoute {
  return async ({ cookies, redirect }) => {
    await logout(cookies);
    return redirect(redirectTo, 302);
  };
}
