# Cloudflare Workers Portfolio Chatbot

A production-ready conversational API deployed on Cloudflare Workers. It acts as an interactive digital twin for my portfolio, answering questions about my background, projects, engineering philosophy, and security research.

The service is built on Cloudflare's serverless edge primitives: WebSockets managed by Durable Objects, semantic search via Vectorize, and inference powered by Workers AI with multi-model fallback.

## System Architecture

```text
Client (Browser)
   |
   |  WebSocket (/chat?sessionId=<uuid>)
   v
Worker Gateway (CORS whitelisting, HTTP security headers, input validation)
   |
   v
Durable Object (ChatSession)
   |-- Rate Limiting: 10 requests/minute per IP (native Cloudflare limiter)
   |-- Session Guard: 20 messages per session with recruiter call-to-action
   |-- Semantic Search: Top-k chunk retrieval from Vectorize via BGE embeddings
   |-- Model Waterfall: Llama 3.1 8B -> Mistral 7B v0.2 -> Llama 3 8B
   `-- Audit Logging: Salted SHA-256 IP hash and PII-redacted queries stored in D1
```

## Core Engineering Decisions

- **Stateful WebSockets with Durable Objects**: Each browser session connects to a designated Durable Object instance. Storage alarms automatically clean up session history and active connections after 24 hours of inactivity.
- **Edge RAG via Vectorize**: `profile.json` is split into semantic chunks (`src/chunker.js`) covering identity, technical skills, employment impact, projects, and security research. Queries are embedded using BAAI BGE (`@cf/baai/bge-small-en-v1.5`) and matched in Vectorize. A static profile fallback ensures zero downtime if vector lookups fail.
- **Prioritized Model Pool**: Serverless GPU nodes can occasionally hit capacity or cold starts. The chat engine automatically cascades across three models (`@cf/meta/llama-3.1-8b-instruct`, `@cf/mistral/mistral-7b-instruct-v0.2`, `@cf/meta/llama-3-8b-instruct`) before serving a graceful fallback.
- **Multi-Layered Abuse & Cost Controls**:
  - Edge rate limiting (10 requests/minute per IP) prevents automated spam.
  - Per-session message ceiling (20 messages) prevents runaway token usage and prompts genuine inquiries toward direct email contact.
  - Hard input caps (500 characters per message) and output caps (`max_tokens: 400`).
- **Privacy by Design**: Incoming questions are scrubbed for email patterns before logging to Cloudflare D1. Client IP addresses are combined with a server-side salt and hashed with SHA-256 so logs contain no raw PII.
- **Strict Browser Security**: Responses enforce `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, strict CSP, and origin checks against whitelisted portfolio domains.

## Development & Testing

### Requirements
- Node.js 18+
- Wrangler CLI (`npm install`)

### Running the Test Suite
Tests run locally against Miniflare using Vitest and `@cloudflare/vitest-pool-workers`:

```bash
npm test
```

### Local Development
```bash
npm run dev
```

### Initializing Vector Embeddings
Populate or update your Vectorize index from `profile.json`:

```bash
npm run setup-vectors
```

Alternatively, push updates in production via the authenticated endpoint:
```bash
curl -X POST https://<your-worker>.workers.dev/sync \
  -H "Authorization: Bearer <SYNC_SECRET_KEY>"
```

### Production Deployment
```bash
npm run deploy
```