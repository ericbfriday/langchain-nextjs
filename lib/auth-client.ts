// lib/auth-client.ts
import { createAuthClient } from "better-auth/client";
import { ssoClient } from "@better-auth/sso/client";

export const authClient = createAuthClient({
  plugins: [ssoClient()],
});

// import { createAuthClient } from "better-auth/react";

// export const authClient = createAuthClient({
//   baseURL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
// });

// export const { useSession, signIn, signUp, signOut } = authClient;
