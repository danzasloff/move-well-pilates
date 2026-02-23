# Move Well Pilates (Cloud-Ready)

This app now supports shared cloud data sync through Supabase, so multiple people can use the same data from any browser.

## What Changed for Cloud
- Added server API endpoints:
  - `GET /api/state`
  - `PUT /api/state`
- Frontend now:
  - Loads local cache first
  - Syncs from cloud on startup
  - Saves to local cache + cloud on edits
- Square token storage now supports Supabase (required for Render persistence).

## Files Added for Migration
- `supabase/schema.sql` (database tables)
- `render.yaml` (Render blueprint)

## 1. Supabase Setup (beginner steps)
1. Go to [https://supabase.com](https://supabase.com) and create a project.
2. In Supabase, open **SQL Editor**.
3. Copy/paste contents of `supabase/schema.sql` and run it.
4. Go to **Project Settings -> API**.
5. Copy these values:
   - `Project URL` (for `SUPABASE_URL`)
   - `service_role` key (for `SUPABASE_SERVICE_ROLE_KEY`)

## 2. Render Deployment (beginner steps)
1. Push this project to GitHub.
2. Go to [https://render.com](https://render.com) and create an account.
3. Click **New +** -> **Blueprint**.
4. Connect your GitHub repo.
5. Render will detect `render.yaml`.
6. In Render service settings, add env vars:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `APP_STATE_KEY` (example: `move-well-default`)
   - `SQUARE_CLIENT_ID`
   - `SQUARE_CLIENT_SECRET`
   - `SQUARE_ENV` (`sandbox` or `production`)
   - `SQUARE_REDIRECT_URI` (your Render URL + `/api/square/oauth/callback`)
   - `SQUARE_VERSION` (default `2025-10-16`)

Example redirect URI after deploy:
- `https://move-well-pilates.onrender.com/api/square/oauth/callback`

## 3. Square Dashboard Update
In Square Developer Dashboard OAuth settings, set callback URL to the Render URL:
- `https://YOUR-RENDER-DOMAIN/api/square/oauth/callback`

The callback in Square must match `SQUARE_REDIRECT_URI` exactly.

## 4. Local Run (optional)
1. Copy env file:
   - `cp .env.example .env`
2. Fill env values.
   - Set `ADMIN_USERS_JSON` for admin login, for example:
     - `[{"email":"shane@example.com","password":"change-me"},{"email":"dan@example.com","password":"change-me"}]`
3. Install and run:
   - `npm install`
   - `npm start`
4. Open:
   - `http://localhost:8787`

## SMTP for New Client Inquiry (Client Portal)
To send new client inquiry submissions by email (instead of opening a mail app), set:
- `SMTP_HOST`
- `SMTP_PORT` (usually `587`)
- `SMTP_SECURE` (`true` for 465, otherwise `false`)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` (sender address/name)
- `INQUIRY_TO_EMAIL` (defaults to `shane@movewellseattle.com`)

After setting these env vars, the Client Portal inquiry form will send directly through the server.

## 5. Verify Cloud Sync
After deployment:
1. Open app in Browser A, add/update a client.
2. Open app in Browser B (or another computer), refresh.
3. You should see the same data.

## Important Notes
- This migration stores app state as JSON in Supabase table `app_states`.
- Files/videos are included in shared state and sync across browsers.
- For larger media libraries, migrate files/videos to Supabase Storage for better performance and lower database load.
# move-well-pilates
# move-well-pilates
# move-well-pilates
# move-well-pilates
