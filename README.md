# Cloudflare Workers AI Digital Twin & Edge RAG Starter Kit

A production-ready conversational AI skeleton and edge API deployed on Cloudflare Workers. It acts as an interactive digital twin and portfolio assistant, answering queries using Retrieval-Augmented Generation (RAG) over structured profile data.

Built on Cloudflare serverless edge primitives: real-time streaming WebSockets via Durable Objects, vector search via Vectorize, and edge LLM inference via Workers AI with multi-model fallback.

## System Architecture

```text
Client (Browser / Chat Widget)
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

## Core Features

- **Stateful WebSockets with Durable Objects**: Each browser session connects to an isolated Durable Object instance. Storage alarms automatically clear conversation history and active connections after 24 hours of inactivity.
- **Configurable Edge RAG**: Splits `profile.json` into semantic chunks (`src/chunker.js`) covering identity, skills, employment impact, projects, and contact info. Queries are embedded using BAAI BGE (`@cf/baai/bge-small-en-v1.5`) and matched in Vectorize. A resilient static fallback handles vector lookup timeouts.
- **Prioritized Model Pool**: The engine cascades through a prioritized pool (`@cf/meta/llama-3.1-8b-instruct`, `@cf/mistral/mistral-7b-instruct-v0.2`, `@cf/meta/llama-3-8b-instruct`) to mitigate serverless GPU cold starts and platform rate limits.
- **Multi-Layered Abuse & Cost Controls**:
  - Edge sliding-window rate limiting (10 requests/minute per IP).
  - Per-session message ceiling (20 messages) prompting visitors toward direct contact.
  - Payload caps (500 characters input, `max_tokens: 400` output).
- **Privacy by Design**: Client IPs are salted and hashed with SHA-256 before insertion into Cloudflare D1. Incoming queries are scrubbed for email patterns to keep audit logs free of raw PII.
- **Template Architecture**: Keeps personal profile data local. Cloners customize `profile.json` from `profile.example.json` without committing personal identifiers to version control.

---

## Quick Start

### 1. Prerequisites
- Node.js 18+
- Cloudflare account with Workers AI, Vectorize, and D1 enabled

### 2. Install Dependencies
```bash
npm install
```
*`npm install` automatically creates your local `profile.json` from `profile.example.json` if one does not already exist.*

### 3. Customize Your Profile
Edit `profile.json` with your own details, projects, and contact information. `profile.json` is gitignored so your personal data remains private to your deployment.

### 4. Run Tests
Validate integration contracts and chunking logic against local Miniflare:
```bash
npm test
```

### 5. Local Development
```bash
npm run dev
```

### 6. Initialize Vector Embeddings
Generate embeddings and populate your Vectorize index from `profile.json`:
```bash
npm run setup-vectors
```

Alternatively, trigger dynamic updates in production via the authenticated sync endpoint:
```bash
curl -X POST https://<your-worker>.workers.dev/sync \
  -H "Authorization: Bearer <SYNC_SECRET_KEY>"
```

### 7. Production Deployment
```bash
npm run deploy
```