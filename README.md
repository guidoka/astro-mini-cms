# astro-mini-cms

Kleines CMS für Astro-SSR-Projekte mit Postgres. Bausteine zum Importieren,
kein Framework: Seitenbaum, Raster-Editor (Zeilen, Spalten, Blöcke, Drag-and-
drop), Medienbibliothek, Anmeldung per E-Mail-Code, Rahmen der Pflege-
oberfläche. Alles läuft im selben Astro-Prozess wie die Seite, Inhalte liegen
in der eigenen Datenbank.

Entstanden aus zwei Kundenprojekten; der dritte Einsatz
kopiert nicht mehr.

## Grundsätze

- **Importieren, nicht generieren.** Das Projekt schreibt seine Admin-Seiten
  selbst (die fachlichen Masken) und holt sich die Bausteine: `saveRow`,
  Formularhelfer, Seitenbaum, Dateien, Editor, Login, Rahmen.
- **Kein Rollenmodell.** Das CMS kennt angemeldet oder nicht. Wer in die
  Pflegeoberfläche darf, sagt das Projekt (`allow`). Weitere Spalten der
  Nutzertabelle (etwa `role`) hängen über `userColumns` am Nutzer.
- **Ablage als Schnittstelle.** Dateisystem, S3/R2 oder eigenes; das Projekt
  wählt per Umgebung.
- **Blocktypen erweiterbar.** Text, Bild, Bildergalerie sind drin; eigene
  Blöcke kommen als zod-Schema (Server) plus Registrierung (Browser) dazu.
- **Kein Build.** Quellen (`.ts`, `.astro`) werden direkt geliefert; Astro
  verarbeitet Pakete mit Namen `astro-*` automatisch (Vite `noExternal`).

## Einbau

```json
// package.json
"dependencies": { "astro-mini-cms": "git+https://github.com/guidoka/astro-mini-cms.git#v0.1.0" },
"scripts": { "postinstall": "astro-mini-cms-tinymce" }
```

Peer-Abhängigkeiten im Projekt: `astro`, `pg`, `zod` (v4), `tinymce`; für
die S3-Ablage `@aws-sdk/client-s3`. Versionen sind Git-Tags, keine Registry.

```js
// astro.config.mjs (zur Sicherheit, Astro erkennt es auch am Namen)
vite: { ssr: { noExternal: ['astro-mini-cms'] } }
```

Schema: `sql/001_cms.sql` ins Projekt kopieren (`db/001_cms.sql`) und mit
eigenen, nummerierten Migrationen erweitern.

### 1. Konfiguration, einmal je Prozess

```ts
// src/lib/cms.ts
import { configureCms, fileSystemStorage } from 'astro-mini-cms';
import { layoutDef } from './layout';
import { sendMail } from './mail';

configureCms({
  brand: 'Meine Seite',
  storage: fileSystemStorage(),                 // oder s3Storage({...}) aus astro-mini-cms/storage/s3
  tables: { users: 'users', sessions: 'sessions', codes: 'otp_codes' },
  cookie: 'meine_session',
  sessionHours: { short: 12, long: 720 },
  selfSignup: false,
  userColumns: ['role'],
  sendCode: (email, code, minutes) => sendMail(email, `Ihr Anmeldecode: ${code}`, …),
  layout: layoutDef,
  pageKinds: { standard: 'Normale Seite', home: 'Startseite' },
  fileUsage: ({ id }) => query(`SELECT 'Kurs' AS kind, title AS name, '/admin/kurse/' || id AS href FROM courses WHERE image_id = $1`, [id]),
});
```

Wer die Konfiguration braucht, importiert diese Datei zuerst: die Middleware
und die Re-Export-Dateien `lib/admin.ts`, `lib/auth.ts`.

### 2. Raster mit eigenen Blöcken

```ts
// src/lib/layout.ts
import { z } from 'zod';
import { defineLayout } from 'astro-mini-cms/layout';

export const CoursesBlock = z.object({ type: z.literal('courses'), course_ids: z.array(z.uuid()).default([]) });
export const layoutDef = defineLayout({ blocks: [CoursesBlock] });
export const { ROW_LAYOUTS, Layout, EMPTY_LAYOUT, parseLayout } = layoutDef;
export type Layout = z.infer<typeof Layout>;
```

```js
// public/admin/blocks.js, Browser-Seite desselben Blocks
window.miniCms.registerBlock('courses', {
  label: 'Kurskacheln', order: 50,
  create: () => ({ type: 'courses', course_ids: [] }),
  render: (body, block, ctx) => { /* Felder aufbauen, in block schreiben */ },
});
```

`ctx` bietet `render`, `bindTiny`, `pickImage`, `esc`, `handle`, `dropZone`,
`moveTo`, `confirm`, `alert`. Gerendert wird das Raster vom Projekt
(`Grid.astro`), das Paket schreibt es nur.

### 3. Middleware

```ts
// src/middleware.ts
import { sequence } from 'astro:middleware';
import { cmsMiddleware } from 'astro-mini-cms/middleware';
import './lib/cms';

export const onRequest = sequence(
  cmsMiddleware({ allow: (user) => user?.role === 'admin' }),
);
```

CSRF-Prüfung für Formular-POSTs, Sitzung in `locals.user`, Tor zu `/admin`.

### 4. Seiten und Endpunkte

```astro
---
// src/pages/admin/login.astro
import LoginView from 'astro-mini-cms/components/LoginView.astro';
import { loginPage } from 'astro-mini-cms/pages';
const p = await loginPage(Astro, { allow: (u) => u?.role === 'admin' });
if (p.redirect) return Astro.redirect(p.redirect, 302);
---
<LoginView {...p} />
```

```astro
---
// src/pages/admin/dateien.astro
import Admin from '../../layouts/Admin.astro';
import FilesView from 'astro-mini-cms/components/FilesView.astro';
import { filesPage } from 'astro-mini-cms/pages';
const p = await filesPage(Astro);
if (p.redirect) return Astro.redirect(p.redirect, 302);
---
<Admin title="Dateien" ok={p.ok} error={p.error}>
  <FilesView {...p} foldersHref="/admin/dateien/ordner" />
</Admin>
```

Ordnerverwaltung (anlegen, umbenennen, Dateien verschieben, leere löschen):

```astro
---
// src/pages/admin/dateien/ordner.astro
import Admin from '../../../layouts/Admin.astro';
import FoldersView from 'astro-mini-cms/components/FoldersView.astro';
import { foldersPage } from 'astro-mini-cms/pages';
const p = await foldersPage(Astro);
if (p.redirect) return Astro.redirect(p.redirect, 302);
---
<Admin title="Ordner" ok={p.ok} error={p.error}><FoldersView {...p} /></Admin>
```

```ts
// src/pages/admin/api/dateien.ts   export const GET = filesListRoute();
// src/pages/admin/api/upload.ts    export const POST = uploadRoute();
// src/pages/abmelden.ts            export const POST = logoutRoute('/');
```

Die Pfade `/admin/api/dateien` und `/admin/api/upload` sind im Editor fest.

### 5. Rahmen und Editor

```astro
---
// src/layouts/Admin.astro
import AdminShell from 'astro-mini-cms/components/AdminShell.astro';
const nav: [string, string][] = [['/admin', 'Übersicht'], ['/admin/seiten', 'Seiten'], …];
---
<AdminShell title={Astro.props.title} nav={nav} logoutAction="/abmelden">
  <slot name="head" slot="head" /><slot />
</AdminShell>
```

In einer Maske mit Raster oder Bildfeld:

```astro
<Scripts slot="head"><script is:inline src="/admin/blocks.js"></script></Scripts>
<LayoutEditor layout={page.layout} />
<ImageField name="hero_image_id" label="Kopfbild" fileId={page.hero_image_id} src={heroSrc} />
```

Die Standardfelder einer Seite liest `pageFieldsFromForm(form, { isNew,
rootHere })`; das Projekt hängt seine Spalten an und ruft `saveRow('pages',
…)` und `recomputePaths()`.

## Seitenzähler

Aufrufe je Stunde und Pfad ohne Cookies, IP oder User-Agent; Besucher je Tag
über ein Tageskennzeichen (Hash aus Tag, Tagessalz, IP, Browser), das am
nächsten Tag samt Salz gelöscht wird. Gezählt werden nur Browser-Navigationen
(Sec-Fetch-Mode navigate, Sec-Fetch-Dest document, Accept-Language), keine
Bots, keine Link-Vorschauen, keine angemeldete Redaktion.

```ts
// Konfiguration (alles optional)
configureCms({ …, stats: {
  timeZone: 'Europe/Zurich',
  countVisitors: async () => (await one(`SELECT stats_visitors FROM site_settings`))?.stats_visitors ?? true,
  pageNames: async (paths) => Object.fromEntries((await query(`SELECT path, name FROM pages WHERE path = ANY($1)`, [paths])).map((r) => [r.path, r.name])),
} });
// Middleware: nach cmsMiddleware, damit locals.user gesetzt ist
export const onRequest = sequence(cmsMiddleware(), statsMiddleware());
// Aufräumjob des Projekts, täglich
await cleanupStats();
// Seite /admin/statistik
const p = await statsPage(Astro);
<Admin title="Statistik"><StatsView {...p} /></Admin>
```

Schema: `sql/003_stats.sql` (page_views, site_visitors, site_days, site_salts).
Stunden bleiben 90 Tage, danach fasst `cleanupStats()` sie zu Tagen zusammen.

## Module

| Import | Inhalt |
|---|---|
| `astro-mini-cms` | alles unten ausser Komponenten und S3 |
| `astro-mini-cms/db` | `pool`, `query`, `one`, `env` |
| `astro-mini-cms/config` | `configureCms`, `cms`, `CmsError` |
| `astro-mini-cms/auth` | `requestCode`, `verifyCode`, `userFromRequest`, `userFromCookies`, `bearerToken`, `setSessionCookie`, `logout`, `endSession`, `sessionHours`, `purgeExpiredAuth` |
| `astro-mini-cms/admin` | `s`, `sOrNull`, `bool`, `int`, `list`, `keywords`, `uuidOrNull`, `slugify`, `saveRow`, `recomputePaths`, `layoutFromForm`, `pageFieldsFromForm`, `readableError`, `flash`, `withFlash` |
| `astro-mini-cms/files` | `listFiles`, `countFiles`, `fileFolders`, `storeUpload`, `fileUsage`, `deleteFile`, `fileSrc` |
| `astro-mini-cms/layout` | `defineLayout`, Kern-Blockschemas |
| `astro-mini-cms/content` | `normalizePath`, `getNav`, `getPage`, `ancestors` |
| `astro-mini-cms/middleware` | `cmsMiddleware` |
| `astro-mini-cms/routes` | `filesListRoute`, `uploadRoute`, `logoutRoute` |
| `astro-mini-cms/pages` | `loginPage`, `filesPage`, `foldersPage`, `pagesIndex` |
| `astro-mini-cms/storage` | `fileSystemStorage`, `layeredStorage`, `Storage` |
| `astro-mini-cms/storage/s3` | `s3Storage` (R2, S3, kompatible) |
| `astro-mini-cms/components/*` | `AdminShell`, `LoginView`, `FilesView`, `FoldersView`, `PagesView`, `LayoutEditor`, `ImageField`, `Scripts`, `CodeFelder` |

## Was die Nutzertabelle braucht

`id`, `email`, `name`, `active`, `last_sign_in_at`. Ein bestehendes Projekt
mit anderem Namen (`admin_users`) trägt den Namen in `tables` ein und
ergänzt fehlende Spalten per Migration. `updated_at` pflegt das Paket nicht
selbst; wer die Spalte hat, setzt den Trigger aus `sql/001_cms.sql`.

## Änderungen

- **0.3.2** — Vorgabe des Untertitels in AdminShell und LoginView ist
  „Adminoberfläche“; beide Projekte nennen es so, `brand` bleibt der reine
  Name.
- **0.3.1** — `subtitle` an LoginView (zweite Zeile im Titel), passend zu
  `subtitle` an AdminShell.
- **0.3.0** — Seitenzähler ohne Cookies (`stats.ts`, `statsMiddleware`,
  `statsPage` + `StatsView`, `cleanupStats`, `sql/003_stats.sql`), aus
  nutri-form herausgelöst; Konfiguration `stats` (Zeitzone, Besucher-Schalter,
  Namensauflösung, Bot-Muster, ausgenommene Pfade).
- **0.2.2** — Bildauswahl: Hochladen und Schliessen als Symbolknöpfe (Pfeil in
  den Kasten, X) mit Tooltip und aria-label.
- **0.2.1** — Bildauswahl lädt beim Scrollen seitenweise nach (dazu ein Knopf
  «Weitere … laden») statt bei 200 Dateien abzubrechen; `/admin/api/dateien`
  nimmt `seite` (ab 1) und antwortet mit `page` und `limit`.
- **0.2.0** — Ordnerverwaltung in der Dateiliste, Dialoge zentriert.
- **0.1.2** — Seitenliste im Admin in Menüreihenfolge.
- **0.1.1** — Eigene Blöcke mit dem Typ eines Kernblocks
  ersetzen diesen (`defineLayout({ blocks })`), TinyMCE-Einstellungen des
  Projekts über `window.miniCms.tinyOptions`, `handle`/`dropZone`/`moveTo`
  in `window.miniCms` für eigene Listen mit Ziehen, `lang` an AdminShell und
  LoginView. Die Verwendungsprüfung schaut nur noch auf `pages.layout` und
  `site_settings.logo_id`; Fusszeilen-Text und weitere Spalten prüft das
  Projekt in `fileUsage`.
- **0.1.0** — Aus dem ersten Projekt herausgelöst (Stand 17.09.2026), dort im
  Einsatz.
