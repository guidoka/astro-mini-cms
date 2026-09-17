// Middleware-Baustein fuer das Projekt:
// 1. CSRF-Schutz fuer Formular-POSTs: der Origin-Host muss zum Host der
//    Anfrage passen. Nur der Host, nicht das Schema, weil TLS am Proxy endet
//    und Astro die Anfrage als http sieht. Ersetzt security.checkOrigin.
//    Anfragen mit Bearer-Token sind ausgenommen: ohne Cookie gibt es keine
//    stillschweigend mitgeschickte Anmeldung, also auch kein CSRF.
// 2. Sitzung fuer jede Anfrage lesen (locals.user).
// 3. Tor zur Pflegeoberflaeche: unterhalb von adminPrefix nur, wen `allow`
//    hereinlaesst; sonst Umleitung zur Anmeldeseite mit ?next=.
//
// Einbau: export const onRequest = sequence(eigenes, cmsMiddleware({ … }))
import type { MiddlewareHandler } from 'astro';
import { bearerToken, userFromRequest, type CmsUser } from './auth';

export interface CmsMiddlewareOptions {
  /** Pfad der Pflegeoberflaeche. */
  adminPrefix?: string;
  /** Anmeldeseite, bleibt ohne Sitzung erreichbar. */
  loginPath?: string;
  /** Wer in die Pflegeoberflaeche darf. Vorgabe: jeder Angemeldete. */
  allow?: (user: CmsUser | null) => boolean;
  /** Origin-Pruefung fuer Formular-POSTs. */
  csrf?: boolean;
}

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

export function cmsMiddleware(opts: CmsMiddlewareOptions = {}): MiddlewareHandler {
  const prefix = (opts.adminPrefix ?? '/admin').replace(/\/+$/, '');
  const login = opts.loginPath ?? `${prefix}/login`;
  const allow = opts.allow ?? ((u) => !!u);
  const csrf = opts.csrf ?? true;

  return async ({ request, cookies, locals, url, redirect }, next) => {
    const token = bearerToken(request);
    if (csrf && !token && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (FORM_TYPES.includes(type)) {
        const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
        const origin = request.headers.get('origin') ?? '';
        let originHost: string | null = null;
        if (origin) {
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = '';
          }
        }
        if (originHost !== null && originHost.toLowerCase() !== host.toLowerCase()) {
          return new Response('Formulare von fremden Seiten sind nicht erlaubt', { status: 403 });
        }
      }
    }

    const user = await userFromRequest(request, cookies);
    (locals as { user?: CmsUser | null }).user = user;

    if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) {
      const open = url.pathname === login || url.pathname === login + '/';
      if (!open && !allow(user)) {
        return redirect(`${login}?next=${encodeURIComponent(url.pathname)}`, 302);
      }
    }
    return next();
  };
}
