/**
 * Hardened Okta SSO Configuration with SQLite
 * Enterprise-grade security implementation for better-auth
 */

import { betterAuth, BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { sso } from "@better-auth/sso";
import { apiKey } from "better-auth/plugins";
import { admin } from "better-auth/plugins";
import { multiSession } from "better-auth/plugins";
import { customSession } from "better-auth/plugins";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

// Environment validation schema
const envSchema = z.object({
  OKTA_ISSUER: z.string().url().startsWith("https://"),
  OKTA_CLIENT_ID: z.string().min(1),
  OKTA_CLIENT_SECRET: z.string().min(32),
  AUTH_SECRET: z.string().min(32),
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ALLOWED_ORIGINS: z.string().transform(s => s.split(",")),
  MAX_LOGIN_ATTEMPTS: z.string().transform(Number).default("5"),
  RATE_LIMIT_WINDOW: z.string().transform(Number).default("900"), // 15 minutes
  SESSION_EXPIRE_DAYS: z.string().transform(Number).default("7"),
  AUDIT_LOG_RETENTION_DAYS: z.string().transform(Number).default("90"),
});

// Validate environment variables
const env = envSchema.parse(process.env);

// Initialize Prisma with connection pooling
const prisma = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  datasources: {
    db: {
      url: env.DATABASE_URL,
    },
  },
});

// Workspace configuration
export interface WorkspaceConfig {
  id: string;
  name: string;
  domain: string;
  oktaTenantId?: string;
  maxUsers: number;
  features: string[];
  securityPolicy: SecurityPolicy;
}

export interface SecurityPolicy {
  mfaRequired: boolean;
  sessionTimeout: number;
  ipWhitelist?: string[];
  passwordPolicy?: {
    minLength: number;
    requireUppercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
    expirationDays?: number;
  };
}

// Audit logging helper
async function auditLog(event: {
  userId?: string;
  action: string;
  resource?: string;
  metadata?: Record<string, any>;
  ip?: string;
  userAgent?: string;
  success: boolean;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: event.userId,
        action: event.action,
        resource: event.resource,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        ip: event.ip,
        userAgent: event.userAgent,
        success: event.success,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    console.error("Audit log failed:", error);
    // Don't throw - audit failures shouldn't break the app
  }
}

// Security headers middleware
export const securityHeaders = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.okta.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.okta.com",
  ].join("; "),
};

// Rate limiting configuration per endpoint
const rateLimitRules = {
  "/sign-in/*": { window: 300, max: 5 }, // 5 attempts per 5 minutes
  "/api/auth/sso/*": { window: 60, max: 10 }, // 10 SSO attempts per minute
  "/api/auth/token": { window: 60, max: 20 }, // 20 token refreshes per minute
  "/api/auth/revoke": { window: 3600, max: 10 }, // 10 revocations per hour
  "/admin/*": { window: 60, max: 30 }, // 30 admin requests per minute
};

// Main auth configuration
const authOptions: BetterAuthOptions = {
  database: prismaAdapter(prisma, {
    provider: "sqlite",
  }),

  // Security configuration
  secret: env.AUTH_SECRET,
  trustedOrigins: env.ALLOWED_ORIGINS,

  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * env.SESSION_EXPIRE_DAYS,
    updateAge: 60 * 60 * 24, // Update daily
    freshAge: 60 * 60, // Fresh for 1 hour
    cookieCache: {
      enabled: true,
      maxAge: 300, // 5 minutes cache
    },
    storeSessionInDatabase: true,
    preserveSessionInDatabase: true, // Keep audit trail
  },

  // Advanced security options
  advanced: {
    useSecureCookies: env.NODE_ENV === "production",
    disableCSRFCheck: false,
    crossSubDomainCookies: {
      enabled: true,
      domain: process.env.COOKIE_DOMAIN,
    },
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
    },
    cookiePrefix: "auth",
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
      disableIpTracking: false,
    },
    database: {
      generateId: ({ model, size }) => {
        // Use CUID2 for better security
        const { createId } = require("@paralleldrive/cuid2");
        return createId();
      },
      defaultFindManyLimit: 100,
    },
  },

  // Rate limiting
  rateLimit: {
    enabled: true,
    window: env.RATE_LIMIT_WINDOW,
    max: 100,
    customRules: rateLimitRules,
    storage: "database",
    modelName: "rateLimit",
  },

  // Email verification
  emailVerification: {
    enabled: true,
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
  },

  plugins: [
    // SSO Plugin with Okta configuration
    sso({
      provisionUser: async ({ user, userInfo, token, provider }) => {
        // Validate Okta claims
        if (!userInfo.email_verified) {
          throw new Error("Email not verified in Okta");
        }

        // Check workspace limits
        const workspace = await getWorkspaceByDomain(userInfo.email.split("@")[1]);
        if (workspace) {
          const userCount = await prisma.user.count({
            where: { workspaceId: workspace.id },
          });

          if (userCount >= workspace.maxUsers) {
            await auditLog({
              action: "SSO_LOGIN_BLOCKED",
              userId: userInfo.sub,
              metadata: { reason: "workspace_user_limit", email: userInfo.email },
              success: false,
            });
            throw new Error("Workspace user limit reached");
          }
        }

        // Provision or update user
        const dbUser = await prisma.user.upsert({
          where: { email: userInfo.email },
          update: {
            name: userInfo.name,
            image: userInfo.picture,
            oktaId: userInfo.sub,
            emailVerified: true,
            lastLoginAt: new Date(),
            metadata: {
              oktaGroups: userInfo.groups || [],
              department: userInfo.department,
              manager: userInfo.manager,
            },
          },
          create: {
            email: userInfo.email,
            name: userInfo.name,
            image: userInfo.picture,
            oktaId: userInfo.sub,
            emailVerified: true,
            workspaceId: workspace?.id,
            role: determineUserRole(userInfo),
            metadata: {
              oktaGroups: userInfo.groups || [],
              department: userInfo.department,
              manager: userInfo.manager,
            },
          },
        });

        // Audit successful login
        await auditLog({
          userId: dbUser.id,
          action: "SSO_LOGIN",
          metadata: { provider: provider.providerId, email: userInfo.email },
          success: true,
        });

        // Sync workspace permissions
        if (workspace) {
          await syncWorkspacePermissions(dbUser.id, workspace.id, userInfo);
        }

        return dbUser;
      },

      organizationProvisioning: {
        disabled: false,
        defaultRole: "member",
        getRole: async ({ userInfo }) => {
          const oktaGroups = userInfo.groups || [];

          // Map Okta groups to application roles
          if (oktaGroups.includes("okta-superadmins")) return "superadmin";
          if (oktaGroups.includes("okta-admins")) return "admin";
          if (oktaGroups.includes("okta-managers")) return "manager";
          if (oktaGroups.includes("okta-developers")) return "developer";
          return "member";
        },
      },
    }),

    // API Key management
    apiKey({
      rateLimit: {
        enabled: true,
        timeWindow: 1000 * 60 * 60, // 1 hour
        maxRequests: 1000,
      },
      customRateLimits: {
        "/api/v1/*": { timeWindow: 1000 * 60, maxRequests: 100 },
      },
    }),

    // Admin panel with role-based access
    admin({
      defaultRole: "member",
      protectedPaths: ["/admin/*", "/api/admin/*"],
    }),

    // Multi-session management
    multiSession({
      maximumSessions: 5,
      enforcementMode: "strict", // Prevent login if limit reached
    }),

    // Custom session enrichment
    customSession(async ({ user, session }, ctx) => {
      const workspace = await prisma.workspace.findUnique({
        where: { id: user.workspaceId },
        include: { securityPolicy: true },
      });

      return {
        user: {
          ...user,
          permissions: await getUserPermissions(user.id),
        },
        session: {
          ...session,
          workspace: workspace ? {
            id: workspace.id,
            name: workspace.name,
            features: workspace.features,
          } : null,
          securityPolicy: workspace?.securityPolicy,
        },
      };
    }),
  ],
};

// Helper functions
async function getWorkspaceByDomain(domain: string) {
  return prisma.workspace.findFirst({
    where: {
      OR: [
        { domain },
        { allowedDomains: { has: domain } },
      ],
    },
  });
}

function determineUserRole(userInfo: any): string {
  const oktaGroups = userInfo.groups || [];
  const jobTitle = userInfo.jobTitle?.toLowerCase() || "";

  if (oktaGroups.includes("okta-superadmins")) return "superadmin";
  if (oktaGroups.includes("okta-admins") || jobTitle.includes("admin")) return "admin";
  if (jobTitle.includes("manager") || jobTitle.includes("director")) return "manager";
  if (jobTitle.includes("developer") || jobTitle.includes("engineer")) return "developer";

  return "member";
}

async function syncWorkspacePermissions(userId: string, workspaceId: string, userInfo: any) {
  const permissions = mapOktaGroupsToPermissions(userInfo.groups || []);

  await prisma.userPermission.deleteMany({
    where: { userId, workspaceId },
  });

  await prisma.userPermission.createMany({
    data: permissions.map(permission => ({
      userId,
      workspaceId,
      permission,
      grantedBy: "okta_sync",
      grantedAt: new Date(),
    })),
  });
}

function mapOktaGroupsToPermissions(oktaGroups: string[]): string[] {
  const permissionMap: Record<string, string[]> = {
    "okta-admins": ["admin.all", "users.manage", "workspace.configure"],
    "okta-managers": ["users.view", "reports.view", "workspace.view"],
    "okta-developers": ["api.access", "workspace.view"],
    "okta-analysts": ["reports.view", "data.export"],
  };

  const permissions = new Set<string>();

  for (const group of oktaGroups) {
    if (permissionMap[group]) {
      permissionMap[group].forEach(p => permissions.add(p));
    }
  }

  return Array.from(permissions);
}

async function getUserPermissions(userId: string): Promise<string[]> {
  const permissions = await prisma.userPermission.findMany({
    where: { userId },
    select: { permission: true },
  });

  return permissions.map(p => p.permission);
}

// Initialize auth
export const auth = betterAuth(authOptions);

// Okta provider registration (run once or dynamically)
export async function registerOktaProvider() {
  try {
    await auth.api.registerSSOProvider({
      body: {
        providerId: "okta",
        issuer: env.OKTA_ISSUER,
        domain: new URL(env.OKTA_ISSUER).hostname.split(".")[0],
        oidcConfig: {
          clientId: env.OKTA_CLIENT_ID,
          clientSecret: env.OKTA_CLIENT_SECRET,
          discoveryEndpoint: `${env.OKTA_ISSUER}/.well-known/openid-configuration`,
          authorizationEndpoint: `${env.OKTA_ISSUER}/v1/authorize`,
          tokenEndpoint: `${env.OKTA_ISSUER}/v1/token`,
          jwksEndpoint: `${env.OKTA_ISSUER}/v1/keys`,
          userInfoEndpoint: `${env.OKTA_ISSUER}/v1/userinfo`,
          scopes: ["openid", "email", "profile", "groups", "offline_access"],
          pkce: true,
          responseType: "code",
          grantType: "authorization_code",
        },
        mapping: {
          id: "sub",
          email: "email",
          emailVerified: "email_verified",
          name: "name",
          image: "picture",
          extraFields: {
            groups: "groups",
            department: "department",
            manager: "manager",
            jobTitle: "title",
            employeeNumber: "employee_number",
          },
        },
      },
    });

    console.log("✅ Okta SSO provider registered successfully");
  } catch (error) {
    console.error("Failed to register Okta provider:", error);
    throw error;
  }
}

// Export types
export type Auth = typeof auth;
export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
export type User = Session["user"];
