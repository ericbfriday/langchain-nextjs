/**
 * Token Rotation and Security Management
 * Implements automatic token rotation, refresh strategies, and security monitoring
 */

import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";
import { createId } from "@paralleldrive/cuid2";

const prisma = new PrismaClient();

// Token configuration
const TOKEN_CONFIG = {
  ACCESS_TOKEN_TTL: 15 * 60 * 1000, // 15 minutes
  REFRESH_TOKEN_TTL: 7 * 24 * 60 * 60 * 1000, // 7 days
  ROTATION_THRESHOLD: 5 * 60 * 1000, // Rotate if less than 5 minutes left
  MAX_REFRESH_COUNT: 10, // Maximum number of refreshes per token family
  JITTER_RANGE: 30 * 1000, // Add random jitter up to 30 seconds
};

// Token family tracking for detecting token reuse
interface TokenFamily {
  familyId: string;
  userId: string;
  createdAt: Date;
  refreshCount: number;
  lastRefreshedAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
}

// Token metadata
interface TokenMetadata {
  jti: string; // JWT ID
  familyId: string;
  userId: string;
  sessionId: string;
  type: "access" | "refresh";
  issuedAt: number;
  expiresAt: number;
  scope: string[];
  clientId?: string;
  deviceId?: string;
}

// Generate secure token
export function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}

// Hash token for storage
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Create token pair
export async function createTokenPair(
  userId: string,
  sessionId: string,
  deviceId?: string,
  scope: string[] = []
): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiry: Date;
  refreshTokenExpiry: Date;
  familyId: string;
}> {
  const familyId = createId();
  const now = Date.now();

  // Add jitter to prevent thundering herd
  const jitter = Math.random() * TOKEN_CONFIG.JITTER_RANGE;

  const accessToken = generateSecureToken();
  const refreshToken = generateSecureToken();

  const accessTokenExpiry = new Date(now + TOKEN_CONFIG.ACCESS_TOKEN_TTL + jitter);
  const refreshTokenExpiry = new Date(now + TOKEN_CONFIG.REFRESH_TOKEN_TTL);

  // Store token metadata
  await prisma.$transaction([
    // Store refresh token
    prisma.refreshToken.create({
      data: {
        id: createId(),
        token: hashToken(refreshToken),
        userId,
        sessionId,
        familyId,
        deviceId,
        expiresAt: refreshTokenExpiry,
        refreshCount: 0,
        scope: JSON.stringify(scope),
      },
    }),

    // Store access token metadata (for revocation checking)
    prisma.accessToken.create({
      data: {
        id: createId(),
        token: hashToken(accessToken),
        userId,
        sessionId,
        familyId,
        expiresAt: accessTokenExpiry,
        scope: JSON.stringify(scope),
      },
    }),

    // Log token issuance
    prisma.auditLog.create({
      data: {
        id: createId(),
        userId,
        action: "TOKEN_ISSUED",
        resource: "token_pair",
        resourceId: familyId,
        success: true,
        metadata: {
          familyId,
          sessionId,
          deviceId,
          scope,
        },
      },
    }),
  ]);

  return {
    accessToken,
    refreshToken,
    accessTokenExpiry,
    refreshTokenExpiry,
    familyId,
  };
}

// Rotate tokens
export async function rotateTokens(
  refreshToken: string,
  clientIp?: string,
  userAgent?: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiry: Date;
  refreshTokenExpiry: Date;
} | null> {
  const hashedToken = hashToken(refreshToken);

  // Find the refresh token
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: hashedToken },
    include: {
      user: true,
      session: true,
    },
  });

  if (!storedToken) {
    // Token not found - possible attack
    await logSecurityEvent("INVALID_REFRESH_TOKEN", null, { clientIp, userAgent });
    return null;
  }

  // Check if token is expired
  if (storedToken.expiresAt < new Date()) {
    await logSecurityEvent("EXPIRED_REFRESH_TOKEN", storedToken.userId, {
      familyId: storedToken.familyId,
      clientIp,
      userAgent,
    });
    return null;
  }

  // Check if token has been revoked
  if (storedToken.revokedAt) {
    // Token reuse detected - revoke entire family
    await revokeTokenFamily(storedToken.familyId, "TOKEN_REUSE_DETECTED");
    await logSecurityEvent("TOKEN_REUSE_DETECTED", storedToken.userId, {
      familyId: storedToken.familyId,
      clientIp,
      userAgent,
    });
    return null;
  }

  // Check refresh count limit
  if (storedToken.refreshCount >= TOKEN_CONFIG.MAX_REFRESH_COUNT) {
    await revokeTokenFamily(storedToken.familyId, "MAX_REFRESH_EXCEEDED");
    await logSecurityEvent("MAX_REFRESH_EXCEEDED", storedToken.userId, {
      familyId: storedToken.familyId,
      refreshCount: storedToken.refreshCount,
    });
    return null;
  }

  // Check session validity
  if (!storedToken.session || storedToken.session.revokedAt) {
    await revokeTokenFamily(storedToken.familyId, "SESSION_INVALID");
    return null;
  }

  // Generate new token pair
  const newAccessToken = generateSecureToken();
  const newRefreshToken = generateSecureToken();

  const now = Date.now();
  const jitter = Math.random() * TOKEN_CONFIG.JITTER_RANGE;

  const accessTokenExpiry = new Date(now + TOKEN_CONFIG.ACCESS_TOKEN_TTL + jitter);
  const refreshTokenExpiry = new Date(now + TOKEN_CONFIG.REFRESH_TOKEN_TTL);

  // Perform rotation in transaction
  await prisma.$transaction([
    // Revoke old refresh token
    prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: {
        revokedAt: new Date(),
        revokedBy: "rotation",
      },
    }),

    // Create new refresh token
    prisma.refreshToken.create({
      data: {
        id: createId(),
        token: hashToken(newRefreshToken),
        userId: storedToken.userId,
        sessionId: storedToken.sessionId,
        familyId: storedToken.familyId,
        deviceId: storedToken.deviceId,
        expiresAt: refreshTokenExpiry,
        refreshCount: storedToken.refreshCount + 1,
        scope: storedToken.scope,
        previousTokenId: storedToken.id,
      },
    }),

    // Create new access token
    prisma.accessToken.create({
      data: {
        id: createId(),
        token: hashToken(newAccessToken),
        userId: storedToken.userId,
        sessionId: storedToken.sessionId,
        familyId: storedToken.familyId,
        expiresAt: accessTokenExpiry,
        scope: storedToken.scope,
      },
    }),

    // Log rotation
    prisma.auditLog.create({
      data: {
        id: createId(),
        userId: storedToken.userId,
        action: "TOKEN_ROTATED",
        resource: "token_pair",
        resourceId: storedToken.familyId,
        success: true,
        metadata: {
          familyId: storedToken.familyId,
          refreshCount: storedToken.refreshCount + 1,
          clientIp,
          userAgent,
        },
      },
    }),
  ]);

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    accessTokenExpiry,
    refreshTokenExpiry,
  };
}

// Revoke token family
export async function revokeTokenFamily(
  familyId: string,
  reason: string
): Promise<void> {
  await prisma.$transaction([
    // Revoke all refresh tokens in family
    prisma.refreshToken.updateMany({
      where: {
        familyId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedBy: reason,
      },
    }),

    // Revoke all access tokens in family
    prisma.accessToken.updateMany({
      where: {
        familyId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedBy: reason,
      },
    }),

    // Log revocation
    prisma.auditLog.create({
      data: {
        id: createId(),
        action: "TOKEN_FAMILY_REVOKED",
        resource: "token_family",
        resourceId: familyId,
        success: true,
        metadata: {
          reason,
        },
      },
    }),
  ]);
}

// Validate access token
export async function validateAccessToken(
  token: string
): Promise<{ valid: boolean; userId?: string; sessionId?: string; scope?: string[] }> {
  const hashedToken = hashToken(token);

  const storedToken = await prisma.accessToken.findUnique({
    where: { token: hashedToken },
    include: {
      session: true,
    },
  });

  if (!storedToken) {
    return { valid: false };
  }

  // Check expiry
  if (storedToken.expiresAt < new Date()) {
    return { valid: false };
  }

  // Check revocation
  if (storedToken.revokedAt) {
    return { valid: false };
  }

  // Check session validity
  if (!storedToken.session || storedToken.session.revokedAt) {
    // Revoke token if session is invalid
    await prisma.accessToken.update({
      where: { id: storedToken.id },
      data: {
        revokedAt: new Date(),
        revokedBy: "session_invalid",
      },
    });
    return { valid: false };
  }

  return {
    valid: true,
    userId: storedToken.userId,
    sessionId: storedToken.sessionId,
    scope: JSON.parse(storedToken.scope || "[]"),
  };
}

// Clean up expired tokens
export async function cleanupExpiredTokens(): Promise<void> {
  const now = new Date();

  await prisma.$transaction([
    // Delete expired refresh tokens
    prisma.refreshToken.deleteMany({
      where: {
        expiresAt: { lt: now },
        createdAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }, // Older than 30 days
      },
    }),

    // Delete expired access tokens
    prisma.accessToken.deleteMany({
      where: {
        expiresAt: { lt: now },
        createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, // Older than 1 day
      },
    }),
  ]);
}

// Log security event
async function logSecurityEvent(
  event: string,
  userId: string | null,
  metadata: Record<string, any>
): Promise<void> {
  await prisma.securityEvent.create({
    data: {
      id: createId(),
      event,
      userId,
      severity: determineSeverity(event),
      metadata,
      timestamp: new Date(),
    },
  });

  // Alert on critical events
  if (determineSeverity(event) === "CRITICAL") {
    await sendSecurityAlert(event, userId, metadata);
  }
}

// Determine event severity
function determineSeverity(event: string): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const criticalEvents = ["TOKEN_REUSE_DETECTED", "MULTIPLE_FAILED_ATTEMPTS"];
  const highEvents = ["MAX_REFRESH_EXCEEDED", "INVALID_REFRESH_TOKEN"];
  const mediumEvents = ["EXPIRED_REFRESH_TOKEN", "SESSION_INVALID"];

  if (criticalEvents.includes(event)) return "CRITICAL";
  if (highEvents.includes(event)) return "HIGH";
  if (mediumEvents.includes(event)) return "MEDIUM";
  return "LOW";
}

// Send security alert
async function sendSecurityAlert(
  event: string,
  userId: string | null,
  metadata: Record<string, any>
): Promise<void> {
  // Implement alerting mechanism (email, Slack, etc.)
  console.error("SECURITY ALERT:", {
    event,
    userId,
    metadata,
    timestamp: new Date().toISOString(),
  });

  // You can integrate with monitoring services here
  // Example: await sendToSlack(alertMessage);
  // Example: await sendToSentry(event, metadata);
}

// Schedule cleanup job
if (typeof window === "undefined") {
  // Run cleanup every hour
  setInterval(() => {
    cleanupExpiredTokens().catch(console.error);
  }, 60 * 60 * 1000);
}

// Export types
export type { TokenFamily, TokenMetadata };
