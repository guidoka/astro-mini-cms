// Ablage in einem S3-kompatiblen Bucket (Cloudflare R2, AWS S3, Hetzner, …).
// Der Bucket ist oeffentlich lesbar, publicUrl ist seine Basisadresse; in
// files.blob_key steht die fertige URL. Braucht @aws-sdk/client-s3 im Projekt.
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Storage } from './index';

export interface S3StorageOptions {
  bucket: string;
  /** Oeffentliche Basis, z. B. https://media.example.com; ohne Schema wird https ergaenzt. */
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2: https://<account>.r2.cloudflarestorage.com; AWS: leer lassen. */
  endpoint?: string;
  /** R2 kennt keine Regionen, 'auto' ist dort der vorgesehene Wert. */
  region?: string;
  /** Bilder aendern sich nie unter demselben Schluessel (zufaelliger Ordner), darum lange cachen. */
  cacheControl?: string;
}

export function s3Storage(o: S3StorageOptions): Storage {
  const raw = o.publicUrl.trim().replace(/\/+$/, '');
  const base = raw && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw;
  if (!base) throw new Error('s3Storage: publicUrl fehlt');
  const client = new S3Client({
    region: o.region ?? 'auto',
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
  });
  return {
    async put(key, body, mime) {
      const clean = key.replace(/^\/+/, '');
      if (clean.includes('..')) throw new Error('Ungueltiger Dateischluessel');
      await client.send(
        new PutObjectCommand({
          Bucket: o.bucket,
          Key: clean,
          Body: body,
          ContentType: mime,
          CacheControl: o.cacheControl ?? 'public, max-age=31536000, immutable',
        }),
      );
      return `${base}/${clean}`;
    },
    async remove(blobKey) {
      if (!blobKey.startsWith(base + '/')) return;
      const key = blobKey.slice(base.length + 1);
      if (!key || key.includes('..')) return;
      await client.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: key }));
    },
  };
}
