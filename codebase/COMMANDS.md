# Lumen Concierge – Commands

Everything runs locally on macOS: Node.js, PostgreSQL + pgvector (Homebrew), no Docker.
Run all commands from the project folder unless noted.

---

## 1. One-time machine setup

```bash
# Node.js 20+ (check)
node -v

# PostgreSQL 17 (Homebrew) – install and start as a background service
brew install postgresql@17
brew services start postgresql@17
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# pgvector for PostgreSQL 17
# (Homebrew's pgvector bottle only targets PostgreSQL 18/19, so build it for 17 from source)
git clone --branch v0.8.7 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector
cd /tmp/pgvector
make PG_CONFIG=/opt/homebrew/opt/postgresql@17/bin/pg_config
make install PG_CONFIG=/opt/homebrew/opt/postgresql@17/bin/pg_config
cd -

# Check pgvector is available
psql -d postgres -c "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

> On PostgreSQL 18 instead: `brew install postgresql@18 pgvector` is enough.

---

## 2. Project setup

```bash
npm install
cp .env.example .env          # then edit .env (Altrum keys, LangSmith key)

npm run db:create             # createdb lumen + CREATE EXTENSION vector
npm run setup                 # seed sample data + ingest policies (RAG) + expand catalogue to 2,020 products
```

`DATABASE_URL` defaults to `postgresql://localhost:5432/lumen` (your macOS user, local trust auth).

---

## 3. Run

```bash
npm start                     # http://localhost:3000
npm run dev                   # same, restarts on file changes
```

| Page | URL |
|---|---|
| Chat | http://localhost:3000 |
| Product catalogue (staff) | http://localhost:3000/products.html |
| Return approvals + audit log (staff) | http://localhost:3000/staff.html |

Staff token = `STAFF_TOKEN` in `.env`.

---

## 4. RAG – policy documents

```bash
npm run ingest                # re-index data/policies/*.md → chunks → local embeddings → pgvector
```

Run it again after editing any file in `data/policies/` (the index is rebuilt from scratch).

```bash
# Inspect the index
psql -d lumen -c "SELECT metadata->>'source' AS doc, count(*) FROM lumen_policies GROUP BY 1 ORDER BY 1;"
psql -d lumen -c "SELECT left(text, 80) FROM lumen_policies WHERE metadata->>'source' = 'return-refund-policy.md';"
```

---

## 5. Offline testing (mock gateway, no API keys)

```bash
# terminal 1 – rule-based fake LLM + imitation guardrails on port 4000
npm run mock-gateway

# terminal 2 – app pointed at the mock (overrides .env for this shell only)
ALTRUM_BASE_URL=http://localhost:4000/v1 ALTRUM_PROVIDER=openai LLM_MODEL=openai/gpt-4o-mini \
ALTRUM_API_KEY=mock ALTRUM_SHOPPING_API_KEY=mock ALTRUM_SUPPORT_API_KEY=mock npm start

# terminal 3 – end-to-end suite (27 checks)
npm test
```

Other checks:

```bash
npm run typecheck
curl localhost:3000/api/health
```

---

## 6. LangSmith (monitoring and graph flow)

In `.env`:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=lumen-concierge
```

Restart `npm start`, send a chat message, then open https://smith.langchain.com → project **lumen-concierge**:
- **Traces**: `chat_turn` → `lumen_concierge` graph → `router` / `shopping` / `support` → LLM and tool runs
- **Threads**: one thread per chat session (metadata `thread_id`)
- Card numbers, emails, phones and ID numbers are masked before upload.

---

## 7. Database

```bash
psql -d lumen                                  # open a shell
psql -d lumen -c "\dt"                         # list tables

# Business data
psql -d lumen -c "SELECT return_id, order_id, status FROM returns ORDER BY created_at DESC LIMIT 10;"
psql -d lumen -c "SELECT ts, event, detail FROM audit_log ORDER BY id DESC LIMIT 10;"

# LangGraph memory (one thread per chat session)
psql -d lumen -c "SELECT thread_id, count(*) AS checkpoints FROM checkpoints GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"

# Start over with an empty database
dropdb lumen && npm run db:create && npm run setup
```

PostgreSQL service:

```bash
brew services list | grep postgres
brew services restart postgresql@17
tail -f /opt/homebrew/var/log/postgresql@17.log
```

---

## 8. Logs

The app logs to the terminal it runs in. To keep a file as well:

```bash
npm start 2>&1 | tee -a logs/app.log           # mkdir logs first
```

---

## npm scripts

| Script | What it does |
|---|---|
| `npm start` / `npm run dev` | Run the server (dev = watch mode) |
| `npm run db:create` | Create the `lumen` database and enable pgvector |
| `npm run seed` | Create business tables and load sample data |
| `npm run ingest` | Rebuild the policy vector index |
| `npm run catalog:expand` | Top the catalogue up to 2,020 products (safe to rerun) |
| `npm run setup` | `seed` + `ingest` + `catalog:expand` |
| `npm run mock-gateway` | Local fake Altrum gateway for offline tests |
| `npm test` | End-to-end tests (server must be running) |
| `npm run typecheck` | TypeScript check |
