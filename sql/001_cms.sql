-- astro-mini-cms: Grundschema. Gefahrlos wiederholbar (CREATE … IF NOT EXISTS).
-- Ins Projekt kopieren (db/001_cms.sql) und dort mit eigenen, nummerierten
-- Migrationen erweitern; das Paket aendert diese Datei nur in neuen Versionen
-- und nennt es im Changelog.
--
-- Tabellen der Anmeldung heissen hier users / otp_codes / sessions. Andere
-- Namen gehen ueber configureCms({ tables }), die Spalten muessen bleiben.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ==========================================================  Dateien
CREATE TABLE IF NOT EXISTS files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_key      text NOT NULL UNIQUE,        -- Pfad (/media/…) oder URL, direkt als src verwendbar
  filename      text NOT NULL,
  mime          text,
  size          int,
  width         int,
  height        int,
  alt           text,
  title         text,
  folder        text,                        -- Ordner nur zur Orientierung, „Upload“ fuer Uploads aus dem Admin
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ==========================================================  Seitenbaum
-- path ist der volle URL-Pfad mit fuehrendem und schliessendem Slash,
-- wird aus der Elternkette berechnet (recomputePaths). Startseite: path '/'.
CREATE TABLE IF NOT EXISTS pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id        uuid REFERENCES pages(id) ON DELETE CASCADE,
  slug             text NOT NULL DEFAULT '',
  path             text NOT NULL UNIQUE,
  kind             text NOT NULL DEFAULT 'standard',
  name             text NOT NULL,             -- Name im Baum und im Menue
  title            text,                      -- H1
  description      text,
  meta_title       text,
  meta_description text,
  layout           jsonb NOT NULL DEFAULT '{"rows":[]}',
  nav_hide         boolean NOT NULL DEFAULT false,
  sort             int NOT NULL DEFAULT 0,
  published        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, slug)
);
CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages(parent_id, sort);

-- Eine Zeile mit den Einstellungen der Seite. Weitere Spalten je Projekt.
CREATE TABLE IF NOT EXISTS site_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  site_name          text NOT NULL DEFAULT 'Website',
  logo_id            uuid REFERENCES files(id) ON DELETE SET NULL,
  logo_alt           text,
  footer_links       jsonb NOT NULL DEFAULT '[]',
  footer_text        text,
  contact_email      text,
  analytics_tag      text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ==========================================================  Anmeldung
CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  name            text,
  active          boolean NOT NULL DEFAULT true,
  last_sign_in_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_email_idx ON otp_codes(email, expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- ==========================================================  Trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$fn$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['files','pages','users'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %1$s_updated_at ON %1$s;
       CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $do$;
