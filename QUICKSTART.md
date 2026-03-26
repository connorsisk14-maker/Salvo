# SALVO Quick Start

## One-command install (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/connorsusk14-maker/Salvo/main/scripts/install.sh | bash
```

Installs all prerequisites (Homebrew, Node 20, pnpm, PostgreSQL 16), clones the repo, configures your environment, runs migrations, and starts the stack. Takes ~3 minutes on a fresh Mac.

---

## Manual install (any platform)

**Prerequisites:** Node 20+, pnpm 9+, PostgreSQL 16+

```bash
# 1. Clone
git clone https://github.com/connorsusk14-maker/Salvo.git ~/salvo
cd ~/salvo

# 2. Install dependencies
pnpm install

# 3. Create database
createdb salvo_dev

# 4. Configure environment
cp .env.example .env
# Edit .env and set at minimum:
#   SALVO_LOCAL_DB_MODE=external
#   SALVO_DATABASE_URL=postgresql://localhost/salvo_dev
#   SALVO_API_TOKEN=$(openssl rand -hex 24)
#   SALVO_WORKSPACE_ROOT=~/salvo-workspace
#   SALVO_LLM_API_KEY=<your Anthropic or OpenAI key>

# 5. Run migrations
pnpm db:migrate

# 6. Build and start
pnpm build
node scripts/prod-up.mjs
```

Open **http://localhost:5173** and enter your `SALVO_API_TOKEN` when prompted.

---

## Your first task

1. Click **Orchestrator Chat** (top-right) or press `Cmd+K`
2. Describe what you want the agent to build or research
3. Review the generated contract — adjust scope, tools, and policy if needed
4. Click **Approve** to queue the run
5. Watch progress in the **Board** → click any run for the live event timeline

---

## Required environment variables

| Variable | Description |
|----------|-------------|
| `SALVO_DATABASE_URL` | PostgreSQL connection string |
| `SALVO_API_TOKEN` | Bearer token for API authentication |
| `SALVO_LLM_API_KEY` | Anthropic or OpenAI API key (or configure via Integrations page) |
| `SALVO_WORKSPACE_ROOT` | Directory for run artifacts and logs |

See `.env.example` for all optional settings and their defaults.

---

## LLM provider setup

SALVO works with any OpenAI-compatible provider. Configure via environment or the **Integrations** page in the dashboard:

```bash
# Anthropic
SALVO_LLM_PROVIDER=anthropic
SALVO_LLM_API_KEY=sk-ant-...

# OpenAI
SALVO_LLM_PROVIDER=openai
SALVO_LLM_API_KEY=sk-...

# Any OpenAI-compatible endpoint (Ollama, Groq, Together, etc.)
SALVO_LLM_PROVIDER=openai
SALVO_LLM_BASE_URL=http://localhost:11434/v1
SALVO_LLM_API_KEY=ollama
SALVO_LLM_DEFAULT_MODEL=llama3.1:8b
```

---

## Stop, update, and restart

```bash
# Stop all services
node scripts/prod-down.mjs

# Update to latest
cd ~/salvo && git pull && pnpm install && pnpm build
node scripts/prod-up.mjs

# View logs
ls ~/salvo-workspace/logs/prod/

# Health check
curl http://localhost:8787/health
```

---

## Local dev mode (no API key required)

Uses a fake LLM stub so you can develop and test without spending tokens:

```bash
export SALVO_LOCAL_DB_MODE=external
export SALVO_DATABASE_URL=postgresql://localhost/salvo_dev
pnpm ux:up      # starts everything including fake LLM stub
pnpm ux:smoke   # run smoke tests
pnpm ux:down    # stop
```

---

## Dashboard pages

| Page | URL | What it shows |
|------|-----|---------------|
| Board | `/` | Task queue, run status, contract approval |
| Control Center | `/control` | Daemon health, budgets, trust tiers, policies, backups |
| Run Detail | `/runs/:id` | Live event timeline, artifacts, proof of work |
| Contract Review | `/contracts` | Contract diff, capability matrix, approval |
| Research Review | `/research` | Experiments, memory synthesis, findings |
| Analytics | `/analytics` | Cost rollups by model, agent profile, category |
| Leads | `/leads` | Lead pipeline funnel and zone progress |
| Skills | `/skills` | Built-in skill registry, per-workspace enable/disable |
| Integrations | `/integrations` | Adapter configs, cost metrics, token usage |
