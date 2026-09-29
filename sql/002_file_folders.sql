-- astro-mini-cms 0.2: Ordnerverwaltung fuer Medien. Gefahrlos wiederholbar.
-- Eine eigene Tabelle, damit leere Ordner existieren koennen und Umbenennen
-- nur eine Zeile aendert statt n Dateien.
CREATE TABLE IF NOT EXISTS file_folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bestehende Ordnernamen aus files uebernehmen.
INSERT INTO file_folders (name)
SELECT DISTINCT folder FROM files WHERE folder IS NOT NULL AND folder <> ''
ON CONFLICT (name) DO NOTHING;
