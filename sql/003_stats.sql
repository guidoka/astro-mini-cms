-- Seitenzaehler ohne Cookies (astro-mini-cms 0.3.0).
-- Aufrufe je Stunde und Pfad; nach 90 Tagen fasst cleanupStats() die Stunden
-- zu Tagen zusammen (hour = Tagesanfang in der konfigurierten Zeitzone).
-- Keine IP, kein User-Agent, kein Cookie.
CREATE TABLE IF NOT EXISTS page_views (
  hour   timestamptz NOT NULL,
  path   text        NOT NULL,
  views  integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, path)
);

-- Besucher je Tag: ein taeglich wechselnder Hash aus Tag, Tagessalz, IP und
-- User-Agent. Zeilen leben nur den Tag; danach bleibt allein die Tageszahl in
-- site_days. Das Salz wird mit dem Tag geloescht, danach ist kein Hash mehr
-- nachrechenbar.
CREATE TABLE IF NOT EXISTS site_visitors (
  day      date NOT NULL,
  visitor  text NOT NULL,
  PRIMARY KEY (day, visitor)
);
CREATE TABLE IF NOT EXISTS site_days (
  day       date    PRIMARY KEY,
  visitors  integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS site_salts (
  day   date PRIMARY KEY,
  salt  text NOT NULL
);
