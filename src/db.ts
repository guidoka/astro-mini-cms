// Ein Pool fuer die ganze App. DATABASE_URL ist Pflicht, ohne Wert bricht der
// Start ab, damit ein falsch konfigurierter Container nicht leer laeuft.
import pg from 'pg';

/**
 * Umgebungsvariable lesen. Erst der Prozess (das, was der Container zur
 * Laufzeit hat), dann die .env aus dem Build: import.meta.env wird beim Bauen
 * fest eingesetzt und waere im Container der Entwicklungswert.
 */
export const env = (k: string): string =>
  process.env[k] ?? (import.meta as { env?: Record<string, string | undefined> }).env?.[k] ?? '';

const url = env('DATABASE_URL');
if (!url) {
  throw new Error('DATABASE_URL fehlt.');
}

// Zahlen als Zahlen, nicht als Strings (int8, numeric).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: url, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
