// Laufzeitkonfiguration des CMS. Das Projekt ruft configureCms() einmal je
// Prozess auf (am besten in einer Datei, die Middleware und lib/admin
// importieren); alle Bausteine lesen danach ueber cms().
//
// Bewusst kein Rollenmodell: das CMS kennt „angemeldet“ oder „nicht
// angemeldet“. Wer in die Pflegeoberflaeche darf, entscheidet das Projekt
// ueber `allow` in der Middleware.
import type { Storage } from './storage/index';
import { defineLayout, type LayoutDef } from './layout';

/** Fehler mit einem Text, der dem Nutzer gezeigt werden darf. */
export class CmsError extends Error {}

export interface FileUse {
  kind: string;
  name: string;
  href: string;
}

export interface CmsConfig {
  /** Name im Kopf der Pflegeoberflaeche und in Mails. */
  brand: string;
  /** Wo hochgeladene Bilder und PDFs landen. */
  storage: Storage;
  /** Tabellen der Anmeldung. Die Spalten stehen in sql/001_cms.sql. */
  tables: { users: string; sessions: string; codes: string };
  /** Name des Sitzungs-Cookies. */
  cookie: string;
  /** Sitzungsdauer in Stunden, ohne und mit „angemeldet bleiben“. */
  sessionHours: { short: number; long: number };
  /** Unbekannte Adressen beim Anmelden als neue Nutzer anlegen. */
  selfSignup: boolean;
  /** Weitere Spalten der Nutzertabelle, die am angemeldeten Nutzer haengen sollen (z. B. role). */
  userColumns: string[];
  /** Den Anmeldecode verschicken. Fehler werden dem Nutzer als Text gezeigt, wenn sie CmsError sind. */
  sendCode: (email: string, code: string, minutes: number) => Promise<void>;
  /** Raster mit den Blocktypen des Projekts. */
  layout: LayoutDef;
  /** Arten von Seiten: Schluessel → Bezeichnung in der Oberflaeche. */
  pageKinds: Record<string, string>;
  /** Weitere Stellen, an denen eine Datei verwendet sein kann (eigene Tabellen des Projekts). */
  fileUsage?: (ctx: { id: string; byPath: string; byId: string }) => Promise<FileUse[]>;
  /** Groesste erlaubte Datei in Bytes. */
  maxUploadBytes: number;
}

export type CmsOptions = Partial<Omit<CmsConfig, 'tables' | 'sessionHours'>> & {
  storage: Storage;
  sendCode: CmsConfig['sendCode'];
  tables?: Partial<CmsConfig['tables']>;
  sessionHours?: Partial<CmsConfig['sessionHours']>;
};

const store = globalThis as { __astroMiniCms?: CmsConfig };

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function configureCms(opts: CmsOptions): CmsConfig {
  const tables = { users: 'users', sessions: 'sessions', codes: 'otp_codes', ...opts.tables };
  for (const [k, v] of Object.entries(tables)) {
    if (!IDENT.test(v)) throw new Error(`Tabellenname fuer ${k} ist ungueltig: ${v}`);
  }
  for (const c of opts.userColumns ?? []) {
    if (!IDENT.test(c)) throw new Error(`Spaltenname ist ungueltig: ${c}`);
  }
  const config: CmsConfig = {
    brand: opts.brand ?? 'Pflegeoberfläche',
    storage: opts.storage,
    tables,
    cookie: opts.cookie ?? 'cms_session',
    sessionHours: { short: 12, long: 24 * 30, ...opts.sessionHours },
    selfSignup: opts.selfSignup ?? false,
    userColumns: opts.userColumns ?? [],
    sendCode: opts.sendCode,
    layout: opts.layout ?? defineLayout(),
    pageKinds: opts.pageKinds ?? { standard: 'Normale Seite', home: 'Startseite' },
    fileUsage: opts.fileUsage,
    maxUploadBytes: opts.maxUploadBytes ?? 20 * 1024 * 1024,
  };
  store.__astroMiniCms = config;
  return config;
}

export function cms(): CmsConfig {
  const c = store.__astroMiniCms;
  if (!c) throw new Error('astro-mini-cms ist nicht konfiguriert: configureCms() fehlt.');
  return c;
}
