# TreeAI — Real AI Tree & Leaf Scanner

This project keeps the existing TreeAI UI and replaces the fake scanner with a real image-analysis request.

## What it does

Upload or drag a tree/leaf image. The frontend sends the compressed image to `/api/analyze-tree`. The Vercel serverless function sends the image to Gemini and returns:

- Tree/species name
- Tamil name
- Scientific name
- AI confidence
- Visible disease/health assessment
- Severity
- Symptoms / visual signs
- Possible causes
- Treatment / management suggestions
- Prevention suggestions

## Vercel setup

1. Put `index.html` in the project root.
2. Keep `api/analyze-tree.js` exactly under the `api` folder.
3. Deploy the project to Vercel.
4. Open **Vercel → Project → Settings → Environment Variables**.
5. Add:
   - Name: `GEMINI_API_KEY`
   - Value: your Google Gemini API key
   - Environment: Production (and Preview if you want preview deployments to work)
6. Redeploy the latest commit.

Never put the Gemini API key inside `index.html` or browser JavaScript.

## Important

The scanner is a visual AI assessment. It is not a laboratory diagnosis. Clear, well-lit images of leaves, bark, fruit, or the full tree will generally give the model more useful evidence.
