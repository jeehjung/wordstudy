# Wordstudy · GitHub Pages + Cloudflare Workers

This repository was empty when the deployment scaffold was added, so the current `index.html` is a small connection-test page rather than a reconstruction of an earlier app UI.

## Architecture

- GitHub Pages serves `index.html`.
- Cloudflare Worker at `worker/src/index.js` exposes a POST endpoint.
- Groq is the primary provider.
- If Groq returns a rate-limit or temporary upstream error (HTTP 408, 429, 500, 502, 503, 504), the Worker tries Gemini.
- Gemini fallback model: `gemini-3.5-flash-lite`.
- Responses use an OpenAI-compatible chat-completions shape and include `provider`, `model`, and `fallback` metadata.

## 1. Deploy GitHub Pages

The workflow at `.github/workflows/pages.yml` deploys the repository root on pushes to `main`.

1. Open **Settings → Pages** in this repository.
2. Set the build/deployment source to **GitHub Actions**.
3. Push to `main` or run the workflow manually under **Actions**.
4. Open the Pages URL shown in the successful deployment.

## 2. Deploy the Worker

Install Node.js and run these commands from the repository root:

```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

Enter each API key when prompted. Do not commit API keys to Git.

- Groq key: https://console.groq.com/
- Gemini key: https://aistudio.google.com/

The deployed URL will look like `https://wordstudy-llm-api.<your-account>.workers.dev`. Paste it into the test page.

## 3. Secrets and configuration

Required secrets:
- `GROQ_API_KEY`
- `GEMINI_API_KEY` (needed for fallback)

Non-secret variables are in `worker/wrangler.toml`:
- `GROQ_MODEL`: `openai/gpt-oss-20b`
- `GEMINI_MODEL`: `gemini-3.5-flash-lite`
- `ALLOWED_ORIGINS`: comma-separated browser origins. The default includes `https://jeehjung.github.io` and common local development origins.

If using a custom domain, add its origin to `ALLOWED_ORIGINS` and redeploy.

## 4. Fallback behavior

Fallback occurs on Groq HTTP 408, 429, 500, 502, 503, or 504. Authentication errors and invalid requests do not silently switch providers; fix the configuration instead.

A successful fallback response contains:
- `provider: "gemini"`
- `fallback: true`
- `fallbackReason: "groq_rate_limit_or_temporary_error"`

The Worker does not store conversation content. Before public use, add application-level authentication, per-user rate limiting, and abuse prevention. Provider free tiers have changing limits and are not unlimited.

## 5. Connect the actual app

Send JSON to the Worker URL:

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful tutor." },
    { "role": "user", "content": "Explain resilient." }
  ],
  "temperature": 0.3,
  "max_tokens": 700
}
```
