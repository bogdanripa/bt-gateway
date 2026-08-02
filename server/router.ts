/**
 * Tiny path router.
 *
 * Routes are registered as literal paths with `:name` segments, e.g.
 * `/api/v1/orders/:id`. Matching is exact on segment count — there are no
 * wildcards and no regex, because every route this service has is a fixed
 * shape and anything cleverer would just be a place for bugs to hide.
 *
 * Static segments beat dynamic ones at the same position, so `/orders/preview`
 * wins over `/orders/:id` regardless of registration order. That ordering used
 * to be implicit in Next's file-system router (a literal directory beat a
 * `[param]` one); making it explicit here keeps the same behaviour.
 */

export type Handler = (
  req: Request,
  ctx: { params: Record<string, string> },
) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  /** Number of literal (non-`:param`) segments — the specificity score. */
  literals: number;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const segments = split(path);
    this.routes.push({
      method: method.toUpperCase(),
      segments,
      literals: segments.filter((s) => !s.startsWith(':')).length,
      handler,
    });
    // Most literal segments first, so a static route always shadows a dynamic
    // one at the same depth.
    this.routes.sort((a, b) => b.literals - a.literals);
    return this;
  }

  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  /**
   * Resolve a request. Returns the handler plus its extracted params, or
   * `{ handler: null, allowed }` when the path exists under other methods —
   * which is a 405, not a 404, and the caller needs `allowed` for the `Allow`
   * header.
   */
  match(method: string, pathname: string): {
    handler: Handler | null;
    params: Record<string, string>;
    allowed: string[];
  } {
    const parts = split(pathname);
    const allowed = new Set<string>();
    for (const r of this.routes) {
      const params = matchSegments(r.segments, parts);
      if (!params) continue;
      allowed.add(r.method);
      if (r.method === method.toUpperCase()) {
        return { handler: r.handler, params, allowed: [...allowed] };
      }
    }
    return { handler: null, params: {}, allowed: [...allowed] };
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function matchSegments(
  pattern: string[],
  parts: string[],
): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      // A path segment arrives percent-encoded; handlers want the real value.
      try {
        params[p.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null; // malformed escape — treat as no match rather than throwing
      }
    } else if (p !== parts[i]) {
      return null;
    }
  }
  return params;
}
