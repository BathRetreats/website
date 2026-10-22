# Bath Retreats guest assistant (RAG chatbot)

Answers guest questions about Abbey Views and Longscroft Manor using the website itself as the knowledge base.

## Run locally

```bash
cd chat
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # from console.anthropic.com
npm start                             # http://localhost:3000
```

No key yet? `CHAT_MOCK=1 npm start` runs the full pipeline and UI, answering with the top retrieved source instead of calling Claude.

## How it works

1. **Ingest** (`build-index.mjs`): parses `index.html`, `abbey.html` and `manor.html` into ~45 small chunks (one per FAQ, room list, amenity list, attraction...) and writes `knowledge.json`. Placeholder testimonials are deliberately excluded. `npm start` re-runs this, so editing the site and restarting is all it takes to update the bot.
2. **Retrieve** (`retrieval.mjs`): BM25 keyword ranking with a guest-wording synonym map, boosted toward the property on the current page or named in the question. Follow-ups use the previous question as context.
3. **Generate** (`server.mjs`): sends the top 6 chunks plus the conversation to Claude (`claude-opus-5`, low effort, refusal fallback enabled) with instructions to answer only from the sources, cite them as [n], and never guess prices or availability. Streams the answer to the browser over Server-Sent Events.
4. **Widget** (`../chat-widget.js`): the chat panel on every page; renders citations as links back to the right page section.

## Test

`npm test`: retrieval eval of 22 guest-style questions (free, no API calls). Run it after changing site content or `retrieval.mjs`.

## Deploy

The site and API need to be served by this Node server (or the API hosted separately):

- **One host (simplest):** deploy the whole `real-estate/` folder to any Node host (Render, Railway, Fly.io, a VPS). Start command `cd chat && npm install && npm start`; set `ANTHROPIC_API_KEY` (and `PORT` if the host requires it) as environment variables.
- **Static site elsewhere:** host the API as above, set `ALLOWED_ORIGIN=https://your-site.com`, and change `data-endpoint` on the `chat-widget.js` script tag in all three pages to `https://your-api-host/api/chat`.

Never put the API key in the HTML or JavaScript files; it stays on the server.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `CHAT_MODEL` | `claude-opus-5` | Model |
| `CHAT_EFFORT` | `low` | `low`/`medium`/`high`; low suits short factual answers |
| `PORT` | `3000` | Server port |
| `ALLOWED_ORIGIN` | (none) | CORS origin when the site is on another domain |
| `LOG_QUESTIONS` | off | `1` logs guest questions (privacy: off by default) |

Limits: 20 messages per IP per 10 minutes, 800 characters per question, 12 turns of history, 2,048 output tokens per answer.
