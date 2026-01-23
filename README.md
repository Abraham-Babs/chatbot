# Cloudflare Workers Chatbot

AI-powered conversational chatbot deployed on Cloudflare Workers with RAG (Retrieval-Augmented Generation) for efficient profile data management.

## Features

- **Real-time WebSocket chat** with Durable Objects
- **IP-based rate limiting** (100 messages/day per IP)
- **RAG implementation** using Vectorize for semantic profile retrieval
- **Multi-model fallback** (Mistral → Llama → Mistral v0.2)
- **Security headers** and input validation

## Setup

### 1. Deploy Worker
```bash
npm run deploy
```

### 2. Initialize Profile Vectors (One-time)
```bash
npm run setup-vectors
```

**Note**: Re-run `setup-vectors` after significant profile.json updates.

## Architecture

- **Durable Objects**: Session management and WebSocket handling
- **Vectorize**: Semantic search for profile chunks
- **Workers AI**: Embeddings and LLM inference
- **KV Storage**: IP rate limiting

## RAG Benefits

- **60-80% token reduction** vs full profile injection
- **5-10x more capacity** on free tier
- **Contextual responses** with relevant profile sections only

## Profile Chunks

The system automatically chunks profile.json into:
- Core identity, skills, experience, education
- Projects, philosophies, personality traits
- Communication style and problem-solving approach