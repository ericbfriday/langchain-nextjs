import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth-config";

// Security headers configuration
const securityHeaders = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.okta.com wss://localhost:* ws://localhost:*",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.okta.com",
    "object-src 'none'",
    "script-src-attr 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
};

// Rate limit tracking (in-memory for edge runtime)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Clean up expired rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (value.resetAt < now) {
      rateLimitMap.delete(key);
    }
  }
}, 60000); // Clean every minute

// Rate limiting function
function checkRateLimit(
  identifier: string,
  path: string,
  limits: { window: number; max: number },
): { allowed: boolean; retryAfter?: number } {
  const key = `${identifier}:${path}`;
  const now = Date.now();

  const entry = rateLimitMap.get(key);

  if (!entry || entry.resetAt < now) {
    // Create new entry
    rateLimitMap.set(key, {
      count: 1,
      resetAt: now + limits.window * 1000,
    });
    return { allowed: true };
  }

  if (entry.count >= limits.max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Increment count
  entry.count++;
  rateLimitMap.set(key, entry);
  return { allowed: true };
}

// Get client IP address
function getClientIp(request: NextRequest): string {
  // Check various headers in order of preference
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  // Fallback to a default
  return "unknown";
}

// Path-specific rate limits
const pathLimits: Record<string, { window: number; max: number }> = {
  "/api/auth/sign-in": { window: 300, max: 5 }, // 5 attempts per 5 minutes
  "/api/auth/sso": { window: 60, max: 10 }, // 10 SSO attempts per minute
  "/api/auth/token": { window: 60, max: 20 }, // 20 token refreshes per minute
  "/api/auth/revoke": { window: 3600, max: 10 }, // 10 revocations per hour
  "/api/admin": { window: 60, max: 30 }, // 30 admin requests per minute
  "/api": { window: 60, max: 100 }, // Default API rate limit
};

// Get rate limit for path
function getRateLimitForPath(path: string): { window: number; max: number } {
  // Check exact match first
  if (pathLimits[path]) {
    return pathLimits[path];
  }

  // Check prefix matches
  for (const [pattern, limits] of Object.entries(pathLimits)) {
    if (path.startsWith(pattern)) {
      return limits;
    }
  }

  // Default rate limit
  return { window: 60, max: 100 };
}

// Protected routes configuration
const protectedRoutes = ["/dashboard", "/profile", "/admin", "/api/protected"];

const publicRoutes = ["/", "/login", "/signup", "/api/auth", "/api/health"];

// Check if route is protected
function isProtectedRoute(path: string): boolean {
  return protectedRoutes.some((route) => path.startsWith(route));
}

// Check if route is public
function isPublicRoute(path: string): boolean {
  return publicRoutes.some((route) => path.startsWith(route));
}

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const path = request.nextUrl.pathname;

  // Apply security headers to all responses
  Object.entries(securityHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  // Add request ID for tracing
  const requestId = crypto.randomUUID();
  response.headers.set("X-Request-ID", requestId);

  // Get client IP
  const clientIp = getClientIp(request);

  // Apply rate limiting to API routes
  if (path.startsWith("/api")) {
    const limits = getRateLimitForPath(path);
    const rateLimitCheck = checkRateLimit(clientIp, path, limits);

    if (!rateLimitCheck.allowed) {
      return new NextResponse("Too Many Requests", {
        status: 429,
        headers: {
          "X-RateLimit-Limit": limits.max.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(
            Date.now() + limits.window * 1000,
          ).toISOString(),
          "Retry-After": rateLimitCheck.retryAfter!.toString(),
        },
      });
    }

    // Add rate limit headers to response
    const entry = rateLimitMap.get(`${clientIp}:${path}`);
    if (entry) {
      response.headers.set("X-RateLimit-Limit", limits.max.toString());
      response.headers.set(
        "X-RateLimit-Remaining",
        (limits.max - entry.count).toString(),
      );
      response.headers.set(
        "X-RateLimit-Reset",
        new Date(entry.resetAt).toISOString(),
      );
    }
  }

  // Session validation for protected routes
  if (isProtectedRoute(path)) {
    try {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session) {
        // Redirect to login
        const url = new URL("/login", request.url);
        url.searchParams.set("redirect", path);
        return NextResponse.redirect(url);
      }

      // Check session freshness for sensitive operations
      if (path.startsWith("/admin") || path.includes("settings")) {
        const sessionAge =
          Date.now() - new Date(session.session.createdAt).getTime();
        const freshAge = 60 * 60 * 1000; // 1 hour

        if (sessionAge > freshAge) {
          // Require re-authentication
          const url = new URL("/login", request.url);
          url.searchParams.set("redirect", path);
          url.searchParams.set("reason", "session-stale");
          return NextResponse.redirect(url);
        }
      }

      // Add user context to headers for downstream use
      response.headers.set("X-User-ID", session.user.id);
      response.headers.set("X-User-Role", session.user.role);

      // Check workspace access
      if (session.user.workspaceId) {
        response.headers.set("X-Workspace-ID", session.user.workspaceId);
      }
    } catch (error) {
      console.error("Session validation error:", error);

      // Redirect to login on error
      const url = new URL("/login", request.url);
      url.searchParams.set("redirect", path);
      return NextResponse.redirect(url);
    }
  }

  // CORS handling for API routes
  if (path.startsWith("/api")) {
    const origin = request.headers.get("origin");
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
    ];

    if (origin && allowedOrigins.includes(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Credentials", "true");
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      response.headers.set("Access-Control-Max-Age", "86400");
    }

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new NextResponse(null, { status: 200, headers: response.headers });
    }
  }

  // Log security events
  if (process.env.NODE_ENV === "production") {
    // Log suspicious activity
    if (path.includes("..") || path.includes("//") || path.includes("\\")) {
      console.warn("Suspicious path detected:", {
        requestId,
        clientIp,
        path,
        userAgent: request.headers.get("user-agent"),
      });

      return new NextResponse("Bad Request", { status: 400 });
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
};
