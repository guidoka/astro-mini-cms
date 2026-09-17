// Anmeldung per E-Mail-Code. Code 6 Ziffern, 10 Minuten gueltig, 5 Versuche.
// In der Datenbank liegen nur Hashes, nie der Code oder das Token.
//
// Kein Rollenmodell: hier gibt es angemeldet oder nicht. Weitere Spalten der
// Nutzertabelle (etwa role) haengt das Projekt ueber userColumns an den
// Nutzer und wertet sie selbst aus.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { one, query } from './db';
import { cms } from './config';

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const OPEN_CODES_MAX = 3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

export interface CmsUser {
  id: string;
  email: string;
  name: string | null;
  [extra: string]: unknown;
}

export const cookieName = (): string => cms().cookie;

/** Wie lange die Anmeldung haelt: eine Arbeitssitzung, oder mit Haken lange. */
export const sessionHours = (remember: boolean): number =>
  remember ? cms().sessionHours.long : cms().sessionHours.short;

const userSelect = () => {
  const extra = cms().userColumns.map((c) => `, u.${c}`).join('');
  return `u.id, u.email, u.name${extra}`;
};

/**
 * Schritt 1: Code erzeugen und mailen. Die Antwort ist immer gleich, damit
 * sich ueber das Formular nicht herausfinden laesst, wer ein Konto hat.
 */
export async function requestCode(emailRaw: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL.test(email)) return;
  const { tables, selfSignup, sendCode } = cms();

  const user = await one<{ id: string; active: boolean }>(
    `SELECT id, active FROM ${tables.users} WHERE lower(email) = $1`,
    [email],
  );
  // Gesperrte Konten bekommen keinen Code. Unbekannte nur, wenn daraus beim
  // Einloesen ein neues Konto werden darf.
  if (user && !user.active) return;
  if (!user && !selfSignup) return;

  const open = await one<{ n: number }>(
    `SELECT count(*) AS n FROM ${tables.codes} WHERE email = $1 AND used_at IS NULL AND expires_at > now()`,
    [email],
  );
  if ((open?.n ?? 0) >= OPEN_CODES_MAX) return;

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    `INSERT INTO ${tables.codes} (email, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [email, sha(code), CODE_MINUTES],
  );
  await sendCode(email, code, CODE_MINUTES);
}

/** Schritt 2: Code pruefen, Konto anlegen falls erlaubt, Sitzung eroeffnen. Gibt das rohe Token zurueck. */
export async function verifyCode(emailRaw: string, codeRaw: string, remember = false): Promise<string | null> {
  const email = emailRaw.trim().toLowerCase();
  const code = codeRaw.replace(/\D/g, '');
  if (code.length !== 6) return null;
  const { tables, selfSignup } = cms();

  const rows = await query<{ id: string; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM ${tables.codes}
     WHERE email = $1 AND used_at IS NULL AND expires_at > now()
     ORDER BY expires_at DESC`,
    [email],
  );
  const want = sha(code);
  let matched: string | null = null;
  for (const r of rows) {
    if (r.attempts >= CODE_ATTEMPTS) continue;
    if (timingSafeEqual(Buffer.from(r.code_hash), Buffer.from(want))) {
      matched = r.id;
      break;
    }
    await query(`UPDATE ${tables.codes} SET attempts = attempts + 1 WHERE id = $1`, [r.id]);
  }
  if (!matched) return null;
  await query(`UPDATE ${tables.codes} SET used_at = now() WHERE id = $1`, [matched]);

  let user = await one<{ id: string; active: boolean }>(
    `SELECT id, active FROM ${tables.users} WHERE lower(email) = $1`,
    [email],
  );
  if (user && !user.active) return null;
  if (!user) {
    if (!selfSignup) return null;
    user = await one<{ id: string; active: boolean }>(
      `INSERT INTO ${tables.users} (email) VALUES ($1) RETURNING id, active`,
      [email],
    );
  }
  if (!user) return null;

  await query(`UPDATE ${tables.users} SET last_sign_in_at = now() WHERE id = $1`, [user.id]);
  const token = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO ${tables.sessions} (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha(token), user.id, sessionHours(remember)],
  );
  return token;
}

export async function userFromToken<U extends CmsUser = CmsUser>(token: string | undefined | null): Promise<U | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { tables } = cms();
  return one<U>(
    `SELECT ${userSelect()}
     FROM ${tables.sessions} s JOIN ${tables.users} u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha(token)],
  );
}

export const userFromCookies = <U extends CmsUser = CmsUser>(cookies: AstroCookies): Promise<U | null> =>
  userFromToken<U>(cookies.get(cookieName())?.value);

/**
 * Sitzungstoken aus der Anfrage ohne Cookie: eine App unter einem anderen
 * Ursprung schickt den Token als Bearer-Header. Bilder im img-Tag koennen
 * keinen Header setzen, deshalb geht bei GET auch ?token=.
 */
export function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(auth);
  if (m) return m[1]!.toLowerCase();
  if (request.method === 'GET') {
    const t = new URL(request.url).searchParams.get('token');
    if (t && /^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  }
  return null;
}

/** Erst der Token aus der Anfrage (App), sonst das Cookie (Seite). */
export async function userFromRequest<U extends CmsUser = CmsUser>(
  request: Request,
  cookies: AstroCookies,
): Promise<U | null> {
  const token = bearerToken(request);
  if (token) return userFromToken<U>(token);
  return userFromCookies<U>(cookies);
}

/** Sitzung zu einem Token beenden. */
export async function endSession(token: string): Promise<void> {
  await query(`DELETE FROM ${cms().tables.sessions} WHERE token_hash = $1`, [sha(token)]);
}

export function setSessionCookie(cookies: AstroCookies, token: string, request: Request, hours?: number): void {
  // Hinter dem Proxy sieht Astro http, der Browser https. Das Secure-Flag
  // richtet sich deshalb nach dem weitergereichten Schema.
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
  cookies.set(cookieName(), token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: proto === 'https',
    // Das Cookie darf nicht laenger leben als die Sitzung in der Datenbank.
    maxAge: 60 * 60 * (hours ?? cms().sessionHours.short),
  });
}

export async function logout(cookies: AstroCookies): Promise<void> {
  const token = cookies.get(cookieName())?.value;
  if (token) await endSession(token);
  cookies.delete(cookieName(), { path: '/' });
}

/** Abgelaufene Codes und Sitzungen entfernen; fuer einen Aufraeumjob des Projekts. */
export async function purgeExpiredAuth(): Promise<{ codes: number; sessions: number }> {
  const { tables } = cms();
  const codes = await query<{ id: string }>(
    `DELETE FROM ${tables.codes} WHERE expires_at < now() - interval '1 day' RETURNING id`,
  );
  const sessions = await query<{ id: string }>(
    `DELETE FROM ${tables.sessions} WHERE expires_at < now() RETURNING id`,
  );
  return { codes: codes.length, sessions: sessions.length };
}
