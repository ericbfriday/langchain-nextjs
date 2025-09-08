/**
 * Health Check and Monitoring System
 * Provides comprehensive health monitoring, metrics collection, and alerting
 */

import { PrismaClient } from "@prisma/client";
import { createId } from "@paralleldrive/cuid2";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

// Health check types
export enum HealthStatus {
  HEALTHY = "healthy",
  DEGRADED = "degraded",
  UNHEALTHY = "unhealthy",
}

export interface HealthCheckResult {
  status: HealthStatus;
  checks: {
    database: ComponentHealth;
    okta: ComponentHealth;
    redis?: ComponentHealth;
    filesystem: ComponentHealth;
    memory: ComponentHealth;
    security: ComponentHealth;
  };
  metrics: SystemMetrics;
  timestamp: Date;
  version: string;
}

export interface ComponentHealth {
  status: HealthStatus;
  responseTime?: number;
  details?: Record<string, any>;
  error?: string;
}

export interface SystemMetrics {
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu: {
    usage: number;
    loadAverage: number[];
  };
  disk: {
    used: number;
    total: number;
    percentage: number;
  };
  activeUsers: number;
  activeSessions: number;
  requestsPerMinute: number;
  errorRate: number;
}

// Performance tracking
const performanceMetrics = new Map<string, number[]>();
const errorCounts = new Map<string, number>();

// Track request metrics
export function trackRequest(endpoint: string, duration: number, success: boolean) {
  const key = `req:${endpoint}`;

  if (!performanceMetrics.has(key)) {
    performanceMetrics.set(key, []);
  }

  const metrics = performanceMetrics.get(key)!;
  metrics.push(duration);

  // Keep only last 100 measurements
  if (metrics.length > 100) {
    metrics.shift();
  }

  if (!success) {
    const errorKey = `error:${endpoint}`;
    errorCounts.set(errorKey, (errorCounts.get(errorKey) || 0) + 1);
  }
}

// Database health check
async function checkDatabase(): Promise<ComponentHealth> {
  const startTime = Date.now();

  try {
    // Test basic connectivity
    await prisma.$queryRaw`SELECT 1`;

    // Check critical tables
    const [userCount, sessionCount, auditCount] = await Promise.all([
      prisma.user.count(),
      prisma.session.count({ where: { isActive: true } }),
      prisma.auditLog.count({
        where: {
          timestamp: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
    ]);

    const responseTime = Date.now() - startTime;

    return {
      status: responseTime < 1000 ? HealthStatus.HEALTHY : HealthStatus.DEGRADED,
      responseTime,
      details: {
        users: userCount,
        activeSessions: sessionCount,
        recentAuditLogs: auditCount,
      },
    };
  } catch (error) {
    return {
      status: HealthStatus.UNHEALTHY,
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : "Database connection failed",
    };
  }
}

// Okta SSO health check
async function checkOkta(): Promise<ComponentHealth> {
  const startTime = Date.now();

  try {
    const oktaIssuer = process.env.OKTA_ISSUER;

    if (!oktaIssuer) {
      return {
        status: HealthStatus.UNHEALTHY,
        error: "Okta configuration missing",
      };
    }

    // Check Okta discovery endpoint
    const response = await fetch(`${oktaIssuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });

    const responseTime = Date.now() - startTime;

    if (response.ok) {
      const config = await response.json();

      return {
        status: HealthStatus.HEALTHY,
        responseTime,
        details: {
          issuer: config.issuer,
          authorization_endpoint: config.authorization_endpoint,
          token_endpoint: config.token_endpoint,
        },
      };
    }

    return {
      status: HealthStatus.DEGRADED,
      responseTime,
      error: `Okta responded with status ${response.status}`,
    };
  } catch (error) {
    return {
      status: HealthStatus.UNHEALTHY,
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : "Okta connection failed",
    };
  }
}

// Filesystem health check
function checkFilesystem(): ComponentHealth {
  try {
    const dbPath = path.join(process.cwd(), "prisma", "dev.db");
    const tempPath = path.join(os.tmpdir(), `health-check-${Date.now()}.tmp`);

    // Test write capability
    fs.writeFileSync(tempPath, "health-check");

    // Test read capability
    const content = fs.readFileSync(tempPath, "utf-8");

    // Clean up
    fs.unlinkSync(tempPath);

    // Check database file
    const dbStats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;

    return {
      status: HealthStatus.HEALTHY,
      details: {
        writeable: true,
        readable: true,
        databaseSize: dbStats ? dbStats.size : 0,
      },
    };
  } catch (error) {
    return {
      status: HealthStatus.UNHEALTHY,
      error: error instanceof Error ? error.message : "Filesystem check failed",
    };
  }
}

// Memory health check
function checkMemory(): ComponentHealth {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryPercentage = (usedMemory / totalMemory) * 100;

  // Node.js heap statistics
  const heapStats = process.memoryUsage();
  const heapPercentage = (heapStats.heapUsed / heapStats.heapTotal) * 100;

  let status = HealthStatus.HEALTHY;

  if (memoryPercentage > 90 || heapPercentage > 90) {
    status = HealthStatus.UNHEALTHY;
  } else if (memoryPercentage > 75 || heapPercentage > 75) {
    status = HealthStatus.DEGRADED;
  }

  return {
    status,
    details: {
      system: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        percentage: memoryPercentage.toFixed(2),
      },
      heap: {
        total: heapStats.heapTotal,
        used: heapStats.heapUsed,
        percentage: heapPercentage.toFixed(2),
      },
      rss: heapStats.rss,
    },
  };
}

// Security health check
async function checkSecurity(): Promise<ComponentHealth> {
  try {
    const issues: string[] = [];

    // Check environment variables
    if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
      issues.push("AUTH_SECRET is not properly configured");
    }

    if (process.env.NODE_ENV === "production") {
      // Production-specific checks
      if (!process.env.ALLOWED_ORIGINS) {
        issues.push("ALLOWED_ORIGINS not configured");
      }

      if (!process.env.COOKIE_DOMAIN) {
        issues.push("COOKIE_DOMAIN not configured");
      }
    }

    // Check for recent security events
    const recentSecurityEvents = await prisma.securityEvent.count({
      where: {
        severity: { in: ["HIGH", "CRITICAL"] },
        timestamp: {
          gte: new Date(Date.now() - 60 * 60 * 1000), // Last hour
        },
      },
    });

    if (recentSecurityEvents > 10) {
      issues.push(`${recentSecurityEvents} high-severity security events in the last hour`);
    }

    // Check failed login attempts
    const failedLogins = await prisma.auditLog.count({
      where: {
        action: "LOGIN_FAILED",
        success: false,
        timestamp: {
          gte: new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
        },
      },
    });

    if (failedLogins > 50) {
      issues.push(`${failedLogins} failed login attempts in the last 15 minutes`);
    }

    return {
      status: issues.length === 0 ? HealthStatus.HEALTHY :
              issues.length <= 2 ? HealthStatus.DEGRADED : HealthStatus.UNHEALTHY,
      details: {
        issues,
        recentSecurityEvents,
        failedLogins,
      },
    };
  } catch (error) {
    return {
      status: HealthStatus.UNHEALTHY,
      error: error instanceof Error ? error.message : "Security check failed",
    };
  }
}

// Get system metrics
async function getSystemMetrics(): Promise<SystemMetrics> {
  const uptime = process.uptime();

  // Memory metrics
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;

  // CPU metrics
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  // Disk metrics (for database file)
  const dbPath = path.join(process.cwd(), "prisma");
  let diskUsed = 0;
  let diskTotal = 0;

  try {
    const stats = fs.statSync(dbPath);
    diskUsed = stats.size;
    // This is a simplified approach - in production, use proper disk usage libraries
    diskTotal = 10 * 1024 * 1024 * 1024; // Assume 10GB for now
  } catch {
    // Ignore disk errors
  }

  // Active users and sessions
  const [activeUsers, activeSessions] = await Promise.all([
    prisma.user.count({
      where: {
        lastLoginAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Active in last 24 hours
        },
      },
    }),
    prisma.session.count({
      where: {
        isActive: true,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);

  // Calculate request metrics
  let totalRequests = 0;
  let totalErrors = 0;

  for (const [key, metrics] of performanceMetrics.entries()) {
    if (key.startsWith("req:")) {
      totalRequests += metrics.length;
    }
  }

  for (const [key, count] of errorCounts.entries()) {
    if (key.startsWith("error:")) {
      totalErrors += count;
    }
  }

  const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

  return {
    uptime,
    memory: {
      used: usedMemory,
      total: totalMemory,
      percentage: (usedMemory / totalMemory) * 100,
    },
    cpu: {
      usage: cpuUsage,
      loadAverage: os.loadavg(),
    },
    disk: {
      used: diskUsed,
      total: diskTotal,
      percentage: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    },
    activeUsers,
    activeSessions,
    requestsPerMinute: totalRequests,
    errorRate,
  };
}

// Main health check function
export async function performHealthCheck(): Promise<HealthCheckResult> {
  const [database, okta, filesystem, memory, security, metrics] = await Promise.all([
    checkDatabase(),
    checkOkta(),
    Promise.resolve(checkFilesystem()),
    Promise.resolve(checkMemory()),
    checkSecurity(),
    getSystemMetrics(),
  ]);

  // Determine overall status
  const components = [database, okta, filesystem, memory, security];
  const unhealthyCount = components.filter(c => c.status === HealthStatus.UNHEALTHY).length;
  const degradedCount = components.filter(c => c.status === HealthStatus.DEGRADED).length;

  let overallStatus = HealthStatus.HEALTHY;
  if (unhealthyCount > 0) {
    overallStatus = HealthStatus.UNHEALTHY;
  } else if (degradedCount > 1) {
    overallStatus = HealthStatus.DEGRADED;
  }

  const result: HealthCheckResult = {
    status: overallStatus,
    checks: {
      database,
      okta,
      filesystem,
      memory,
      security,
    },
    metrics,
    timestamp: new Date(),
    version: process.env.npm_package_version || "1.0.0",
  };

  // Log health check result
  await logHealthCheck(result);

  // Send alerts if needed
  if (overallStatus === HealthStatus.UNHEALTHY) {
    await sendHealthAlert(result);
  }

  return result;
}

// Log health check results
async function logHealthCheck(result: HealthCheckResult) {
  try {
    await prisma.healthCheck.create({
      data: {
        id: createId(),
        status: result.status,
        checks: result.checks,
        metrics: result.metrics,
        timestamp: result.timestamp,
      },
    });
  } catch (error) {
    console.error("Failed to log health check:", error);
  }
}

// Send health alerts
async function sendHealthAlert(result: HealthCheckResult) {
  const unhealthyComponents = Object.entries(result.checks)
    .filter(([_, health]) => health.status === HealthStatus.UNHEALTHY)
    .map(([name, health]) => ({ name, error: health.error }));

  console.error("HEALTH ALERT:", {
    status: result.status,
    unhealthyComponents,
    metrics: result.metrics,
    timestamp: result.timestamp,
  });

  // Implement alerting (email, Slack, PagerDuty, etc.)
  // Example: await sendToSlack(alertMessage);
  // Example: await sendToSentry(result);
}

// Schedule health checks
if (typeof window === "undefined") {
  // Run health check every minute
  setInterval(() => {
    performHealthCheck().catch(console.error);
  }, 60 * 1000);
}

// Export for API endpoint
export default performHealthCheck;
