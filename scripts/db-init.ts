#!/usr/bin/env tsx
/**
 * Database Initialization and Migration Script
 * Handles database setup, migrations, and initial seeding
 */

import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createId } from "@paralleldrive/cuid2";

const prisma = new PrismaClient();

// Configuration
const DB_PATH = path.join(process.cwd(), "prisma", "dev.db");
const BACKUP_DIR = path.join(process.cwd(), "prisma", "backups");
const MIGRATION_DIR = path.join(process.cwd(), "prisma", "migrations");

// Color codes for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function log(message: string, type: "info" | "success" | "warning" | "error" = "info") {
  const typeColors = {
    info: colors.blue,
    success: colors.green,
    warning: colors.yellow,
    error: colors.red,
  };

  console.log(`${typeColors[type]}${colors.bright}[${type.toUpperCase()}]${colors.reset} ${message}`);
}

// Database backup
async function backupDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    log("No existing database to backup", "info");
    return;
  }

  // Create backup directory if it doesn't exist
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `backup-${timestamp}.db`);

  try {
    fs.copyFileSync(DB_PATH, backupPath);
    log(`Database backed up to: ${backupPath}`, "success");

    // Keep only last 10 backups
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("backup-"))
      .sort()
      .reverse();

    if (backups.length > 10) {
      backups.slice(10).forEach(backup => {
        fs.unlinkSync(path.join(BACKUP_DIR, backup));
        log(`Removed old backup: ${backup}`, "info");
      });
    }
  } catch (error) {
    log(`Backup failed: ${error}`, "error");
    throw error;
  }
}

// Check database health
async function checkDatabaseHealth() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    log("Database connection successful", "success");
    return true;
  } catch (error) {
    log(`Database connection failed: ${error}`, "error");
    return false;
  }
}

// Run Prisma migrations
async function runMigrations(reset = false) {
  try {
    if (reset) {
      log("Resetting database...", "warning");
      execSync("npx prisma migrate reset --force", { stdio: "inherit" });
    } else {
      log("Running database migrations...", "info");
      execSync("npx prisma migrate deploy", { stdio: "inherit" });
    }

    log("Generating Prisma client...", "info");
    execSync("npx prisma generate", { stdio: "inherit" });

    log("Migrations completed successfully", "success");
  } catch (error) {
    log(`Migration failed: ${error}`, "error");
    throw error;
  }
}

// Create default workspace
async function createDefaultWorkspace() {
  const existingWorkspace = await prisma.workspace.findFirst({
    where: { slug: "default" },
  });

  if (existingWorkspace) {
    log("Default workspace already exists", "info");
    return existingWorkspace;
  }

  const workspace = await prisma.workspace.create({
    data: {
      id: createId(),
      name: "Default Workspace",
      slug: "default",
      domain: process.env.DEFAULT_DOMAIN || "localhost",
      allowedDomains: JSON.stringify([
        "localhost",
        process.env.DEFAULT_DOMAIN || "example.com",
      ]),
      maxUsers: 100,
      maxApiKeys: 20,
      features: JSON.stringify([
        "sso",
        "api_access",
        "audit_logs",
        "custom_roles",
      ]),
      plan: "enterprise",

      // Create associated security policy
      securityPolicy: {
        create: {
          id: createId(),
          mfaRequired: false,
          sessionTimeout: 28800, // 8 hours
          idleTimeout: 1800, // 30 minutes
          maxConcurrentSessions: 5,
          passwordMinLength: 12,
          passwordRequireUpper: true,
          passwordRequireNumber: true,
          passwordRequireSpecial: true,
          passwordHistoryCount: 5,
          dataRetentionDays: 90,
          auditLogRetentionDays: 365,
        },
      },
    },
    include: {
      securityPolicy: true,
    },
  });

  log(`Created default workspace: ${workspace.name}`, "success");
  return workspace;
}

// Create default admin user
async function createAdminUser(workspaceId: string) {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";

  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingAdmin) {
    log("Admin user already exists", "info");
    return existingAdmin;
  }

  const adminUser = await prisma.user.create({
    data: {
      id: createId(),
      email: adminEmail,
      name: "System Administrator",
      emailVerified: true,
      role: "superadmin",
      workspaceId,
      metadata: {
        createdBy: "system",
        isSystemAdmin: true,
      },
    },
  });

  // Grant all permissions
  const permissions = [
    "admin.all",
    "users.manage",
    "workspace.configure",
    "api.manage",
    "audit.view",
    "security.configure",
  ];

  await prisma.userPermission.createMany({
    data: permissions.map(permission => ({
      id: createId(),
      userId: adminUser.id,
      workspaceId,
      permission,
      grantedBy: "system",
    })),
  });

  log(`Created admin user: ${adminEmail}`, "success");
  return adminUser;
}

// Create rate limit entries
async function initializeRateLimits() {
  const endpoints = [
    "/sign-in",
    "/api/auth/sso",
    "/api/auth/token",
    "/api/v1",
  ];

  for (const endpoint of endpoints) {
    const key = `rate_limit:${endpoint}`;
    const existing = await prisma.rateLimit.findUnique({
      where: { key },
    });

    if (!existing) {
      await prisma.rateLimit.create({
        data: {
          id: createId(),
          key,
          count: 0,
          resetAt: new Date(Date.now() + 60000), // Reset in 1 minute
        },
      });
      log(`Initialized rate limit for: ${endpoint}`, "info");
    }
  }
}

// Validate environment variables
function validateEnvironment() {
  const required = [
    "DATABASE_URL",
    "AUTH_SECRET",
    "OKTA_ISSUER",
    "OKTA_CLIENT_ID",
    "OKTA_CLIENT_SECRET",
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    log(`Missing required environment variables: ${missing.join(", ")}`, "error");
    log("Please check your .env file", "warning");
    return false;
  }

  // Validate AUTH_SECRET strength
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length < 32) {
    log("AUTH_SECRET should be at least 32 characters long", "warning");
  }

  return true;
}

// Clean up old audit logs
async function cleanupAuditLogs(retentionDays = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  const result = await prisma.auditLog.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate,
      },
    },
  });

  if (result.count > 0) {
    log(`Cleaned up ${result.count} old audit logs`, "info");
  }
}

// Main initialization function
async function initialize() {
  console.log(`${colors.bright}${colors.blue}
╔════════════════════════════════════════╗
║   Database Initialization & Migration   ║
╚════════════════════════════════════════╝
${colors.reset}`);

  try {
    // Step 1: Validate environment
    log("Validating environment...", "info");
    if (!validateEnvironment()) {
      process.exit(1);
    }

    // Step 2: Backup existing database
    log("Creating database backup...", "info");
    await backupDatabase();

    // Step 3: Check database health
    log("Checking database health...", "info");
    const isHealthy = await checkDatabaseHealth();

    // Step 4: Run migrations
    const shouldReset = process.argv.includes("--reset");
    if (shouldReset) {
      log("Reset flag detected - will reset database", "warning");
    }

    await runMigrations(shouldReset || !isHealthy);

    // Step 5: Create default data
    log("Setting up default data...", "info");
    const workspace = await createDefaultWorkspace();
    await createAdminUser(workspace.id);
    await initializeRateLimits();

    // Step 6: Cleanup old data
    log("Performing cleanup tasks...", "info");
    await cleanupAuditLogs();

    // Step 7: Verify setup
    const userCount = await prisma.user.count();
    const workspaceCount = await prisma.workspace.count();

    console.log(`
${colors.green}${colors.bright}✅ Database initialization complete!${colors.reset}

📊 Database Statistics:
   • Workspaces: ${workspaceCount}
   • Users: ${userCount}
   • Database: ${DB_PATH}

🔐 Security:
   • Rate limiting: Enabled
   • Audit logging: Enabled
   • Session management: Configured

🚀 Next steps:
   1. Run: yarn dev
   2. Visit: http://localhost:3000
   3. Login with SSO or create a new account
    `);

  } catch (error) {
    log(`Initialization failed: ${error}`, "error");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if executed directly
if (require.main === module) {
  initialize().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

export { initialize, backupDatabase, runMigrations };
