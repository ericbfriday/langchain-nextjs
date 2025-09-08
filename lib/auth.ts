// lib/auth.ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { sso } from "@better-auth/sso";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "sqlite",
  }),
  // Hybrid approach: Okta for auth, SQLite for sessions
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days local session
    updateAge: 60 * 60 * 24, // Refresh every day
    // Sessions stored in SQLite, not dependent on Okta
  },

  plugins: [
    sso({
      provisionUser: async ({ user, userInfo, token }) => {
        // Sync Okta profile to local DB
        await prisma.user.upsert({
          where: { email: userInfo.email },
          update: {
            name: userInfo.name,
            image: userInfo.picture,
            oktaId: userInfo.sub,
            emailVerified: userInfo.email_verified,
          },
          create: {
            email: userInfo.email,
            name: userInfo.name,
            image: userInfo.picture,
            oktaId: userInfo.sub,
            emailVerified: userInfo.email_verified,
          },
        });

        // Create default workspace/settings
        await createUserDefaults(user.id);
      },
      organizationProvisioning: {
        getRole: async ({ userInfo }) => {
          const oktaGroups = userInfo.groups || [];

          if (oktaGroups.includes("okta-admins")) return "admin";
          if (oktaGroups.includes("okta-managers")) return "manager";
          return "member";
        },
      },
    }),
  ],
});

// statis registration in auth.ts
// // Option A: Static registration in auth.ts
await auth.api.registerSSOProvider({
  body: {
    providerId: "okta",
    issuer: process.env.OKTA_ISSUER!, // e.g., https://dev-123456.okta.com
    domain: "yourdomain.com",
    oidcConfig: {
      clientId: process.env.OKTA_CLIENT_ID!,
      clientSecret: process.env.OKTA_CLIENT_SECRET!,
      discoveryEndpoint: `${process.env.OKTA_ISSUER}/.well-known/openid-configuration`,
      scopes: ["openid", "email", "profile", "groups"],
      pkce: true, // Enable PKCE for security
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
      },
    },
  },
});

//
//
//
// import { betterAuth } from "better-auth";
// import { prismaAdapter } from "better-auth/adapters/prisma";
// import { PrismaClient } from "@prisma/client";

// const prisma = new PrismaClient();

// export const auth = betterAuth({
//   database: prismaAdapter(prisma, {
//     provider: "sqlite",
//   }),
//   emailAndPassword: {
//     enabled: true,
//   },
//   session: {
//     expiresIn: 60 * 60 * 24 * 7, // 7 days
//     updateAge: 60 * 60 * 24, // 1 day
//   },
//   // Optional: Add OAuth providers
//   // socialProviders: {
//   //   github: {
//   //     clientId: process.env.GITHUB_CLIENT_ID!,
//   //     clientSecret: process.env.GITHUB_CLIENT_SECRET!,
//   //   },
//   //   google: {
//   //     clientId: process.env.GOOGLE_CLIENT_ID!,
//   //     clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
//   //   },
//   // },
// });
