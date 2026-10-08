# 🌿 TreeAI — Tamil Nadu Tree Intelligence

Upload a photo of a tree, leaf, bark or fruit and get a **real AI analysis** (species, Tamil name, health, possible disease, management tips) powered by **Google Gemini**. Results can be saved to your private **scan history** stored in **Supabase**. Deployable to **Vercel**, ready for **GitHub**.

> ⚠️ Results are AI assessments from a picture — **not laboratory diagnoses**. Always confirm important decisions with a qualified agricultural/forestry expert (e.g. your local Krishi Vigyan Kendra or TNAU).

---

## 1. What's inside

```
TreeAI/
├── public/                   ← the website (your original TreeAI design)
│   ├── index.html            ← your HTML/CSS design + new scanner/history/modal markup
│   ├── src/app.js            ← all browser logic (auth, upload, scanner, history, chat)
│   └── assets/favicon.svg
├── api/                      ← backend (Vercel serverless functions)
│   ├── config.js             GET    /api/config        public Supabase URL + anon key
│   ├── analyze-tree.js       POST   /api/analyze-tree  image → Gemini → validated JSON
│   ├── save-scan.js          POST   /api/save-scan     save a scan to Supabase
│   ├── scan-history.js       GET    /api/scan-history  list / get one (?id=) / DELETE (?id=)
│   ├── tree.js               GET    /api/tree/:id      species details + known diseases
│   ├── species.js            GET    /api/species       tree catalogue (Explore page)
│   ├── chat.js               POST   /api/chat          TreeAI assistant (Gemini)
│   └── _lib/                 shared code (not routes): auth, Gemini client, validation
├── supabase/schema.sql       ← COMPLETE database + storage + security + seed data
├── scripts/dev-server.js     ← local dev server (no extra install needed)
├── test/                     ← automated tests (npm test)
├── .env.example              ← environment variable names
├── vercel.json  package.json  .gitignore  README.md
```

**How a scan works**

```
Browser  ──resize + upload──▶  Supabase Storage (private bucket "tree-images", folder = your user id)
Browser  ──POST /api/analyze-tree {image_path}──▶  Backend
Backend  ──verifies your login, downloads the image──▶  Gemini (multimodal, JSON output)
Backend  ──validates the JSON (never trusts raw AI output)──▶  Browser shows the result
Browser  ──"Save result" → POST /api/save-scan──▶  Supabase table scan_results
```

The Gemini key lives only on the server. The browser never talks to Gemini directly.

---

## 2. Environment variables (what is safe, what is secret)

| Variable | Where it is used | Safe in the browser? |
|---|---|---|
| `GEMINI_API_KEY` | `/api` functions only | ❌ **SECRET – server only** |
| `SUPABASE_SERVICE_ROLE_KEY` | `/api` functions only (bypasses security rules) | ❌ **SECRET – server only** |
| `SUPABASE_URL` | server + sent to browser via `/api/config` | ✅ Public |
| `SUPABASE_ANON_KEY` | server + sent to browser via `/api/config` | ✅ Public (protected by Row Level Security) |
| `GEMINI_MODEL` *(optional)* | server | – (default `gemini-3.5-flash`) |
| `GEMINI_FALLBACK_MODEL` *(optional)* | server | – (default `gemini-3.1-flash-lite`) |

Nothing is hard-coded: the website fetches the two public values from `/api/config` at start-up, so you never edit `index.html` to add keys.

> Note on models: `gemini-2.5-flash` is scheduled to shut down on **16 Oct 2026**, so TreeAI defaults to `gemini-3.5-flash`. If Google renames models later, just set `GEMINI_MODEL` in Vercel — no code change.

---

## 3. Setup, step by step

### Step 1 — Install Node.js
Install Node.js **20 or newer** from https://nodejs.org (check with `node -v`).

### Step 2 — Get the code
```bash
cd TreeAI
npm install
```

### Step 3 — Create a Gemini API key
1. Open https://aistudio.google.com/apikey and sign in with Google.
2. Click **Create API key** and copy it. → this is `GEMINI_API_KEY`.
3. (The free tier works for testing; check Google's current limits.)

### Step 4 — Create a Supabase project
1. Go to https://supabase.com → **New project** (choose a region near you, e.g. Mumbai / Singapore) and set a database password.
2. Wait until it finishes starting.
3. Open **Project Settings → API**. Copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (keep secret!)
   *(If your dashboard shows newer "publishable / secret" keys, use the publishable key as the anon key and the secret key as the service-role key.)*

### Step 5 — Create the tables, security rules and storage bucket
1. In Supabase open **SQL Editor → New query**.
2. Open `supabase/schema.sql`, copy **everything**, paste, click **Run**.
3. You should see "Success". This creates: `profiles`, `tree_species`, `tree_diseases`, `scan_results`, `scan_symptoms`, the `scan_history` view, Row Level Security policies, the private **`tree-images`** storage bucket (+ its policies), and seed data for 12 Tamil Nadu trees (Neem, Banyan, Peepal, Mango, Coconut, Tamarind, Guava, Drumstick, Teak, Indian Gooseberry, Jackfruit, Casuarina) with common diseases.
4. Verify: **Table Editor** shows the tables; **Storage** shows the `tree-images` bucket.
5. It is safe to run the script again later (it is idempotent).

*Adding more species later:* insert rows into `tree_species` (and `tree_diseases`) in the Table Editor. The scanner is **not** limited to this list — Gemini analyses every image dynamically; the table is used for the Explore page and to link scans to known species.

### Step 6 — Configure Supabase sign-in
In **Authentication → Providers → Email** make sure Email is enabled.
- For easiest testing, you may turn **"Confirm email"** off. If it stays on, new users must click the link in their email before signing in.
- In **Authentication → URL Configuration** set **Site URL** to your site address (`http://localhost:3000` while testing; your Vercel URL after deploying) and add the same to **Redirect URLs**. This makes confirmation and password-reset links come back to TreeAI.

### Step 7 — Set environment variables locally
```bash
cp .env.example .env        # Windows: copy .env.example .env
```
Open `.env` and paste your four values.

### Step 8 — Run locally
```bash
npm run dev
```
Open http://localhost:3000. (Alternatively: `npx vercel dev`.)

### Step 9 — Test the scanner (checklist)
1. Create an account (or sign in).
2. Go to **Scan**, click **Upload image** (or drag & drop, or **Take photo** on a phone) and pick a clear photo of a tree/leaf.
3. Watch the progress messages; the result appears with name, Tamil name, scientific name, family, confidence, health, disease, severity, symptoms, causes, management, prevention and observations.
4. Click **Save result** → "Scan saved successfully".
5. Open **Home → View all** (or **Profile → Scan history**) → your scan is listed; click it for the full analysis.
6. Try a non-tree photo (e.g. a cup): you should get a friendly "doesn't look like a tree" message.
7. Open **Ask TreeAI** and ask a question about your scan.

Run the automated tests any time with `npm test`.

---

## 4. Push to GitHub
```bash
git init
git add .
git commit -m "TreeAI: first version"
git branch -M main
git remote add origin https://github.com/<your-username>/TreeAI.git
git push -u origin main
```
`.gitignore` already excludes `.env`, `node_modules` and `.vercel`, so your keys are never uploaded. **Double-check** with `git status` that `.env` is not listed before pushing.

## 5. Deploy to Vercel
1. Go to https://vercel.com → **Add New… → Project** → import your GitHub repo.
2. Leave **Framework Preset = Other**. (`vercel.json` already sets the output folder to `public`.)
3. Open **Environment Variables** and add: `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (and optionally `GEMINI_MODEL`).
4. Click **Deploy**.
5. Copy your live URL (e.g. `https://treeai.vercel.app`) and put it into Supabase → **Authentication → URL Configuration** (Site URL + Redirect URLs).
6. Open the site and run the test checklist above.

Every `git push` to `main` redeploys automatically. If you change environment variables later, **redeploy** for them to take effect.

---

## 6. Security notes
- Gemini and service-role keys exist only as server environment variables.
- All API routes (except the public catalogue/config) require a valid Supabase login token.
- Scan data is protected twice: backend checks **and** database Row Level Security (users can only touch their own rows and their own folder in storage).
- Images live in a **private** bucket and are shown through short-lived signed links. Photos are resized in the browser first (this also strips GPS metadata).
- The AI's JSON is validated and clamped on the server before it is shown or saved. Error messages never include keys, stack traces or database internals.
- Treatment advice is deliberately conservative (no pesticide names or doses).
- Rate limiting in the API is best-effort (in-memory). For heavy public use add a proper limiter (e.g. Upstash) and set a spending cap on your Gemini key.

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| Login page says "app is not configured" | Environment variables missing. Check `.env` (local) or Vercel settings, then restart / redeploy. |
| `Missing environment variables` warning in the terminal | Copy `.env.example` to `.env` and fill all four values. |
| "Incorrect email or password" for a new account | If "Confirm email" is on in Supabase, confirm via the email link first. |
| Confirmation/reset email link goes to the wrong site | Fix **Site URL / Redirect URLs** in Supabase → Authentication → URL Configuration. |
| "The image could not be uploaded" | Make sure you ran **all** of `schema.sql` (it creates the `tree-images` bucket and policies). |
| "AI service is unavailable" / `AI_ERROR` | Check `GEMINI_API_KEY`; confirm the model name in `GEMINI_MODEL` exists; check quota at https://aistudio.google.com. Server logs (Vercel → Logs) show the exact reason. |
| "We could not save your scan" | Re-run `schema.sql`; confirm `SUPABASE_URL` matches the project that holds the tables. |
| Explore page shows the built-in list only | The `tree_species` table is empty or unreachable — re-run the seed part of `schema.sql`. |
| Scan takes very long on Vercel Hobby | The function limit is 60 s (set in `vercel.json`). Retry; a smaller/clearer photo helps. |
| Camera button does nothing on desktop | "Take photo" opens the camera on phones; on desktop it opens the file picker. |
| Voice (mic) says unsupported | Speech input needs a browser with the Web Speech API (e.g. Chrome/Edge/Safari). |

**Known limitation:** if someone scans an image but closes the page without saving, that photo stays in their private storage folder until they scan again (the app then cleans it up) — you can also clear old files from Storage in the Supabase dashboard.

## 8. Customising
- Colours, fonts and layout are all in the `<style>` block of `public/index.html` (unchanged from your design; new styles are grouped at the bottom under "TreeAI functional additions").
- The AI instructions (what Gemini must and must not do) are in `api/_lib/gemini.js`.
- Validation rules for AI output are in `api/_lib/validate.js`.
