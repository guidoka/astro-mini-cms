// Ablage fuer Bilder und PDFs des CMS. Das Paket kennt nur die Schnittstelle;
// wohin die Dateien gehen, entscheidet das Projekt (Dateisystem, S3/R2, …).
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Storage {
  /** Datei ablegen. Gibt zurueck, was in files.blob_key steht und direkt als src taugt (URL oder Pfad). */
  put(key: string, body: Buffer, mime: string): Promise<string>;
  /** Datei zu einem blob_key entfernen. Keys, die nicht zu dieser Ablage gehoeren, werden ignoriert. */
  remove(blobKey: string): Promise<void>;
}

/**
 * Entwicklung und kleine Seiten: Dateien unter public/<prefix>, ausgeliefert
 * von Astro selbst. Im Container geht das verloren, dort gehoert eine
 * externe Ablage hin.
 */
export function fileSystemStorage(opts: { dir?: string; urlPrefix?: string } = {}): Storage {
  const prefix = (opts.urlPrefix ?? '/media').replace(/\/+$/, '');
  const dir = opts.dir ?? join(process.cwd(), 'public', prefix.replace(/^\/+/, ''));
  return {
    async put(key, body) {
      const clean = key.replace(/^\/+/, '');
      if (clean.includes('..')) throw new Error('Ungueltiger Dateischluessel');
      // Der Schluessel beginnt mit dem Prefix ohne Slash (media/…); der Rest kommt darunter.
      const rel = clean.startsWith(prefix.slice(1) + '/') ? clean.slice(prefix.length) : clean;
      const target = join(dir, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, body);
      return `${prefix}/${rel}`;
    },
    async remove(blobKey) {
      if (!blobKey.startsWith(prefix + '/') || blobKey.includes('..')) return;
      try {
        unlinkSync(join(dir, blobKey.slice(prefix.length)));
      } catch {
        /* Datei fehlt schon, egal */
      }
    },
  };
}

/**
 * Mehrere Ablagen hintereinander: geschrieben wird in die erste, geloescht
 * in allen. Nuetzlich, wenn eine Datenbank Dateien aus zwei Zeiten kennt
 * (lokale Pfade aus der Entwicklung und URLs aus dem Bucket).
 */
export function layeredStorage(primary: Storage, ...others: Storage[]): Storage {
  return {
    put: (key, body, mime) => primary.put(key, body, mime),
    async remove(blobKey) {
      for (const s of [primary, ...others]) await s.remove(blobKey);
    },
  };
}
