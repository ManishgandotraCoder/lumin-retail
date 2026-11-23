# Lumen MCP

Standalone MCP server (Express) for the Lumen Retail catalogue, stock and store policies.
It reads the same Postgres + pgvector database as the Lumen Concierge app; load that database
there first (`npm run setup` in `../codebase`).

| Tool | Needs |
|---|---|
| `search_products`, `check_inventory` | Postgres |
| `search_policies` | Postgres + embeddings (`EMBEDDING_PROVIDER`) |
| `get_order_status`, `prepare_return_request` | only when `LUMEN_CUSTOMER_ID` is set (one customer; never on a public deployment) |

Every call is written to `audit_log` (agent `mcp`, PII masked).

## Run locally

```bash
cd mcp
npm install
cp .env.example .env          # set DATABASE_URL
npm start                     # HTTP: http://127.0.0.1:3100/mcp   (health: /health)
npm run stdio                 # stdio, for clients that start the process
```

Connect a client:

```bash
# HTTP
claude mcp add --transport http lumen http://127.0.0.1:3100/mcp --header "Authorization: Bearer <MCP_TOKEN>"
# stdio
claude mcp add lumen -- npx tsx /absolute/path/to/mcp/src/stdio.ts
```

## Deploy on Vercel

1. New Vercel project from the luminretail repo, **Root Directory: `mcp`**, Framework preset: **Other**.
   (`vercel.json` routes every path to the Express app in `api/index.ts`.)
2. Environment variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | **pooled** connection string (Neon / Supabase), pgvector enabled and loaded |
   | `MCP_TOKEN` | `openssl rand -hex 32`; required |
   | `EMBEDDING_PROVIDER` | `huggingface` (FastEmbed is too large for a Vercel function) |
   | `HF_TOKEN` | Hugging Face access token (read) |
   | `MCP_ALLOWED_HOSTS` | optional, e.g. `lumen-mcp.vercel.app,mcp.example.com` |

3. Deploy, then check `https://<project>.vercel.app/health` and connect:
   `claude mcp add --transport http lumen https://<project>.vercel.app/mcp --header "Authorization: Bearer <MCP_TOKEN>"`

The Hugging Face provider uses the same model (BAAI/bge-base-en-v1.5), pooling and `query:`/`passage:`
prefixes as FastEmbed, so the vectors stored by the main app's ingest keep working.

## Layout

```
api/index.ts     Vercel entry (exports the Express app)
src/app.ts       Express: /mcp (auth, host check, MCP handler), /health
src/server.ts    local HTTP server
src/stdio.ts     stdio transport
src/mcp.ts       MCP server + tool registration, token check
src/tools.ts     the 5 tools (SQL)
src/policies.ts  pgvector policy search
src/embeddings.ts  local (FastEmbed) / Hugging Face query embeddings
src/config.ts, db.ts, audit.ts
```
