# Vercel Environment Variables

When deploying the **web app** (`apps/web`) to Vercel, add these environment variables
in your Vercel project settings under **Settings → Environment Variables**.

## Required Variables

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_CONTROL_PLANE_URL` | `https://ckxxpyzxsbhhynlboyid.supabase.co` | Control-plane Supabase project URL |
| `NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY` | _(your control-plane anon key)_ | Safe to expose — RLS enforces access |
| `NEXT_PUBLIC_API_URL` | `https://your-api-server.com` | URL of your deployed Express API (`apps/api`) |
| `NEXT_PUBLIC_SITE_URL` | `https://your-vercel-deployment.vercel.app` | Your Vercel production URL (for QR code generation) |

## Vercel Project Setup

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import **shiraz-eng/Automation-Restaurant** from GitHub
3. Set **Root Directory** to `apps/web`
4. Set **Framework Preset** to `Next.js`
5. Add the environment variables above
6. Click **Deploy**

Vercel will automatically run:
- Install: `npm install` (at monorepo root — installs shared package too)
- Build: `next build` (inside `apps/web`)

## API Server

The Express API (`apps/api`) is a Node.js server and **cannot** run on Vercel's
serverless functions as-is. Deploy it separately to one of:
- **Railway** — `railway up` from `apps/api`
- **Render** — Connect repo, set root to `apps/api`, build: `npm run build`, start: `node dist/server.js`
- **Fly.io** — Add a `Dockerfile` in `apps/api`

Then set `NEXT_PUBLIC_API_URL` to your deployed API URL in Vercel.
