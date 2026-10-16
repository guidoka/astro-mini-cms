// Seitenzaehler ohne Cookies (0.3.0, aus nutri-form A40 herausgeloest).
//
// Stufe 1, Aufrufe: je ausgelieferter oeffentlicher HTML-Seite eine Zaehlung
// in page_views (Stunde, Pfad). Keine IP, kein User-Agent, kein Cookie, also
// kein Personenbezug und kein Banner.
//
// Stufe 2, Besucher: wie bei Plausible ein Hash aus Tag, Tagessalz, IP und
// User-Agent, der nur den Tag lebt (site_visitors), danach bleibt die
// Tageszahl (site_days). Die IP wird im Moment des Aufrufs verarbeitet, nie
// gespeichert; das Salz wird mit dem Tag geloescht. Das Projekt schaltet die
// Stufe ueber cms().stats.countVisitors (z. B. aus seinen Einstellungen).
//
// Gezaehlt wird nur, was ein Browser als Seitennavigation angefordert hat
// (Sec-Fetch-Mode: navigate, Sec-Fetch-Dest: document, Accept-Language);
// Link-Scanner mit Browser-Kennung schicken das fast nie (Befund 16.10.2026:
// zehn «Besucher» am ersten Tag bei zwei bekannten Lesern).
//
// Zeitzone: Tage und Stunden in cms().stats.timeZone, damit «heute» dem
// Kalender der Redaktion entspricht; page_views.hour bleibt timestamptz.
import { createHash, randomBytes } from 'node:crypto';
import { pool } from './db';
import { cms } from './config';

const tz = () => cms().stats.timeZone;

/** Heutiges Datum in der Zeitzone als YYYY-MM-DD. */
export function todayInZone(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

let salt: { day: string; value: string } | null = null;
async function saltFor(day: string): Promise<string> {
  if (salt?.day === day) return salt.value;
  const { rows: [r] } = await pool.query<{ salt: string }>(
    `INSERT INTO site_salts (day, salt) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET salt = site_salts.salt RETURNING salt`,
    [day, randomBytes(16).toString('hex')]);
  salt = { day, value: r!.salt };
  return r!.salt;
}

let visitorsSetting: { at: number; on: boolean } | null = null;
async function countVisitors(): Promise<boolean> {
  if (visitorsSetting && Date.now() - visitorsSetting.at < 60_000) return visitorsSetting.on;
  const on = await cms().stats.countVisitors();
  visitorsSetting = { at: Date.now(), on };
  return on;
}

/** Zaehlt, wenn die Antwort eine oeffentliche HTML-Seite ist, die ein Browser
 *  als Seitennavigation angefordert hat. */
export function shouldCount(method: string, path: string, status: number, contentType: string | null, headers: Headers, loggedIn: boolean): boolean {
  const { botPattern, excludePrefixes } = cms().stats;
  if (method !== 'GET' || status !== 200) return false;
  if (!contentType || !contentType.includes('text/html')) return false;
  if (excludePrefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'))) return false;
  if (loggedIn) return false; // Redaktion zaehlt nicht mit
  const userAgent = headers.get('user-agent');
  if (!userAgent || botPattern.test(userAgent)) return false;
  if (headers.get('sec-fetch-mode') !== 'navigate' || headers.get('sec-fetch-dest') !== 'document') return false;
  if (!headers.get('accept-language')) return false;
  return true;
}

/** Einen Aufruf zaehlen. Nie awaiten: laeuft nach der Antwort. */
export async function recordView(path: string, ip: string, userAgent: string): Promise<void> {
  await pool.query(
    `INSERT INTO page_views (hour, path, views) VALUES (date_trunc('hour', now()), $1, 1)
     ON CONFLICT (hour, path) DO UPDATE SET views = page_views.views + 1`, [path]);
  if (!(await countVisitors())) return;
  const day = todayInZone();
  const visitor = createHash('sha256').update(`${day}|${await saltFor(day)}|${ip}|${userAgent}`).digest('hex').slice(0, 32);
  const ins = await pool.query(`INSERT INTO site_visitors (day, visitor) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [day, visitor]);
  if (ins.rowCount) {
    await pool.query(`INSERT INTO site_days (day, visitors) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET visitors = site_days.visitors + 1`, [day]);
  }
}

/** Aufraeumen, taeglich aus dem Aufraeumjob des Projekts: Tages-Hashes und
 *  Salze von gestern und frueher weg, Stunden aelter als 90 Tage zu Tagen
 *  zusammenfassen. Wiederholbar. */
export async function cleanupStats(): Promise<Record<string, number>> {
  const n: Record<string, number> = {};
  const today = todayInZone();
  n.besucher_hashes = (await pool.query(`DELETE FROM site_visitors WHERE day < $1`, [today])).rowCount ?? 0;
  n.salze = (await pool.query(`DELETE FROM site_salts WHERE day < $1`, [today])).rowCount ?? 0;
  // Tagesanfang in der Zone als timestamptz: lokale Zeit ohne Zone, dann wieder in die Zone gesetzt.
  const dayStart = `(date_trunc('day', hour AT TIME ZONE $1) AT TIME ZONE $1)`;
  await pool.query(
    `INSERT INTO page_views (hour, path, views)
     SELECT ${dayStart}, path, sum(views) FROM page_views
     WHERE hour < now() - interval '90 days' AND hour <> ${dayStart}
     GROUP BY 1, 2
     ON CONFLICT (hour, path) DO UPDATE SET views = page_views.views + EXCLUDED.views`, [tz()]);
  n.stunden_zusammengefasst = (await pool.query(`DELETE FROM page_views WHERE hour < now() - interval '90 days' AND hour <> ${dayStart}`, [tz()])).rowCount ?? 0;
  return n;
}

// ---- Auswertung --------------------------------------------------------------
export type Resolution = 'hour' | 'day' | 'week' | 'month' | 'year';
export const RESOLUTIONS: Record<Resolution, string> = { hour: 'Stunde', day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' };
const LABEL_FMT: Record<Resolution, string> = { hour: 'DD.MM. HH24:00', day: 'DD.MM.YYYY', week: '"KW" IW IYYY', month: 'MM.YYYY', year: 'YYYY' };

export interface Bucket { label: string; views: number; visitors: number | null }

/** Verlauf von `from` (inklusive) bis `to` (exklusiv) in der Aufloesung, Luecken mit 0. */
export async function series(from: Date, to: Date, res: Resolution): Promise<Bucket[]> {
  const { rows } = await pool.query<Bucket>(
    `WITH b AS (
       SELECT generate_series(date_trunc($3, $1::timestamptz AT TIME ZONE $5),
                              ($2::timestamptz - interval '1 second') AT TIME ZONE $5,
                              ('1 ' || $3)::interval) AS t)
     SELECT to_char(b.t, $4) AS label,
            coalesce((SELECT sum(v.views) FROM page_views v
                      WHERE v.hour >= $1 AND v.hour < $2 AND date_trunc($3, v.hour AT TIME ZONE $5) = b.t), 0)::int AS views,
            CASE WHEN $3 = 'hour' THEN NULL ELSE
              coalesce((SELECT sum(d.visitors) FROM site_days d
                        WHERE d.day >= ($1::timestamptz AT TIME ZONE $5)::date AND d.day < ($2::timestamptz AT TIME ZONE $5)::date + 1
                          AND date_trunc($3, d.day::timestamp) = b.t), 0)::int END AS visitors
     FROM b ORDER BY b.t`,
    [from, to, res, LABEL_FMT[res], tz()]);
  return rows;
}

export interface TopPage { path: string; name: string | null; views: number }

/** Meistgesehene Seiten im Zeitraum; Namen liefert das Projekt ueber cms().stats.pageNames. */
export async function topPages(from: Date, to: Date, limit = 30): Promise<TopPage[]> {
  const { rows } = await pool.query<{ path: string; views: number }>(
    `SELECT path, sum(views)::int AS views FROM page_views WHERE hour >= $1 AND hour < $2
     GROUP BY path ORDER BY 2 DESC, 1 LIMIT $3`, [from, to, limit]);
  const names = cms().stats.pageNames ? await cms().stats.pageNames!(rows.map((r) => r.path)) : {};
  return rows.map((r) => ({ ...r, name: names[r.path] ?? null }));
}

export async function totals(from: Date, to: Date): Promise<{ views: number; visitors: number; pages: number }> {
  const { rows: [r] } = await pool.query<{ views: number; visitors: number; pages: number }>(
    `SELECT coalesce((SELECT sum(views) FROM page_views WHERE hour >= $1 AND hour < $2), 0)::int AS views,
            coalesce((SELECT sum(visitors) FROM site_days WHERE day >= ($1::timestamptz AT TIME ZONE $3)::date AND day < ($2::timestamptz AT TIME ZONE $3)::date + 1), 0)::int AS visitors,
            (SELECT count(DISTINCT path) FROM page_views WHERE hour >= $1 AND hour < $2)::int AS pages`, [from, to, tz()]);
  return r!;
}

/** Erster Tag mit Messwerten (YYYY-MM-DD in der Zone) oder null, wenn noch nichts gezaehlt wurde. */
export async function firstDay(): Promise<string | null> {
  const { rows: [r] } = await pool.query<{ d: string | null }>(`SELECT to_char(min(hour) AT TIME ZONE $1, 'YYYY-MM-DD') AS d FROM page_views`, [tz()]);
  return r?.d ?? null;
}

/** Mitternacht des Tages YYYY-MM-DD in der Zone als Date; addDays verschiebt den Tag. */
export function dayStart(ymd: string, addDays = 0): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const noon = new Date(Date.UTC(y!, m! - 1, d! + addDays, 12)); // Mittag, sicher im richtigen Tag
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(noon);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: '2-digit', hour12: false, timeZoneName: 'longOffset' }).formatToParts(noon);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const mo = /GMT([+-])(\d{2}):(\d{2})/.exec(off);
  const offMin = mo ? (mo[1] === '-' ? -1 : 1) * (Number(mo[2]) * 60 + Number(mo[3])) : 0;
  const [ly, lm, ld] = local.split('-').map(Number);
  return new Date(Date.UTC(ly!, lm! - 1, ld!) - offMin * 60_000);
}
