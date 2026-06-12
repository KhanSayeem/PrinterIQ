import type { User } from "@supabase/supabase-js";

const PUBLIC_ROUTES = ["/login"];
const HANDLER_AUTH_ROUTES = ["/api/import-csv", "/api/leads"];

function hasHandlerAuth(pathname: string) {
  return HANDLER_AUTH_ROUTES.includes(pathname);
}

export function isPublicRoute(pathname: string) {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function getAuthRedirect(requestUrl: URL, user: Pick<User, "id"> | null) {
  if (user || isPublicRoute(requestUrl.pathname) || hasHandlerAuth(requestUrl.pathname)) {
    return null;
  }

  const redirectUrl = new URL("/login", requestUrl.origin);
  redirectUrl.searchParams.set("redirectedFrom", requestUrl.pathname);
  return redirectUrl;
}
