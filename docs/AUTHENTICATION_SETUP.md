# Better Auth Integration Guide

## Overview
This project now includes Better Auth for user authentication with email/password support and optional OAuth providers.

## Features Implemented
- ✅ Email/password authentication
- ✅ User registration and login
- ✅ Protected routes with middleware
- ✅ User dashboard
- ✅ Session management
- ✅ SQLite database with Prisma

## Getting Started

### 1. Environment Variables
Update your `.env.local` file with a secure secret key:
```bash
BETTER_AUTH_SECRET=your-secure-secret-key-here
```

### 2. Database Setup
The database is already initialized. To reset or modify:
```bash
npx prisma migrate dev
```

### 3. Running the Application
```bash
yarn dev
```

## Available Routes

- `/login` - User login page
- `/signup` - User registration page
- `/dashboard` - Protected user dashboard (requires authentication)

## Authentication Flow

1. **Registration**: Users can sign up at `/signup` with email and password
2. **Login**: Existing users can log in at `/login`
3. **Protected Routes**: The middleware automatically redirects unauthenticated users to login
4. **Dashboard**: Authenticated users can access their dashboard at `/dashboard`

## Adding OAuth Providers (Optional)

To add GitHub or Google authentication:

1. Update `.env.local`:
```bash
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

2. Uncomment the socialProviders section in `/lib/auth.ts`

## Customization

### Protected Routes
Edit `middleware.ts` to add more protected routes:
```typescript
const protectedRoutes = ["/dashboard", "/profile", "/settings", "/your-route"];
```

### User Schema
Modify `prisma/schema.prisma` to add custom user fields, then run:
```bash
npx prisma migrate dev
```

## Security Notes

1. **Change the default secret**: Replace `BETTER_AUTH_SECRET` with a strong, unique value
2. **HTTPS in production**: Always use HTTPS in production environments
3. **Session expiry**: Currently set to 7 days, adjust in `/lib/auth.ts` as needed

## Troubleshooting

- **Database errors**: Run `npx prisma generate` to regenerate the Prisma client
- **Session issues**: Check that cookies are enabled and the domain is correct
- **Migration errors**: Delete `prisma/dev.db` and run `npx prisma migrate dev` to reset