# WACA — WhatsApp Client Tracker Agent

**WhatsApp → Postgres → LLM Triage → Dashboard**

A self-hosted client communication tracker that listens to WhatsApp via Baileys, stores messages in Postgres, triages them with an LLM, and serves a React dashboard for managing clients, tasks, and sources.

## Architecture

```
┌─────────────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Baileys WA Client  │     │   Postgres   │     │   Dashboard      │
│  + LLM Triage       │────▶│              │◀────│   (Express +     │
│  (ingest.js)        │     │  messages    │     │    React/shadcn) │
│                     │     │  tasks       │     │                  │
│  llm.js             │     │  clients     │     │  server.js       │
│  (multi-provider)   │     │  wa_sources  │     │  frontend/       │
└─────────────────────┘     └──────────────┘     └──────────────────┘
```

## Components

| File/Dir        | Purpose                                                      |
|-----------------|--------------------------------------------------------------|
| `ingest.js`     | Baileys WhatsApp listener → stores messages → LLM triage    |
| `llm.js`        | Multi-provider LLM layer (Ollama, OpenAI, Anthropic, Grok)  |
| `server.js`     | Express REST API + serves the built React frontend           |
| `frontend/`     | React + Tailwind + shadcn/ui dashboard                       |
| `schema.sql`    | Postgres schema (clients, messages, tasks, wa_sources, team) |
| `env.example`   | Environment config template                                  |

---

## Installation

### Prerequisites

| Tool         | Version | Install                                              |
|--------------|---------|------------------------------------------------------|
| Node.js      | 18+     | `brew install node` or use nvm (see below)           |
| PostgreSQL   | 14+     | Local: `brew install postgresql@14` / Cloud: see below |
| Ollama       | latest  | `brew install ollama` (only if using local LLM)      |

### Step 1: Clone and install

```bash
git clone https://github.com/ug911/antiwaca.git
cd antiwaca

# Use correct Node version (repo includes .nvmrc)
nvm install
nvm use

# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend
npm install
cd ..
```

### Step 2: Set up Postgres

Choose **one** option:

#### Option A: Local Postgres

```bash
# Start Postgres (if not running)
brew services start postgresql@14

# Create the database and apply schema
createdb wise_tracker
psql wise_tracker < schema.sql
```

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=wise_tracker
DB_USER=your_username
DB_PASSWORD=your_password
```

#### Option B: Neon (recommended cloud — free tier)

1. Sign up at [neon.tech](https://neon.tech) and create a project
2. Copy the connection string from the dashboard
3. Apply the schema: `psql "your-connection-string" < schema.sql`

```env
DATABASE_URL=postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/wise_tracker?sslmode=require
```

#### Option C: Supabase (free tier)

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings > Database** and copy the connection string
3. Run the schema via the **SQL Editor** tab (paste `schema.sql` contents) or via `psql`

```env
DATABASE_URL=postgresql://postgres.xxx:pass@aws-0-region.pooler.supabase.com:6543/postgres
```

#### Option D: ElephantSQL (free "Tiny Turtle" plan)

1. Create an instance at [elephantsql.com](https://www.elephantsql.com)
2. Copy the URL from instance details
3. Apply schema via their **Browser** SQL console or `psql`

```env
DATABASE_URL=postgres://user:pass@stampy.db.elephantsql.com/dbname
```

#### Option E: Railway (free trial)

1. Create a Postgres service at [railway.com](https://railway.com)
2. Copy the `DATABASE_URL` from the **Variables** tab
3. Apply schema: `psql "$DATABASE_URL" < schema.sql`

```env
DATABASE_URL=postgresql://postgres:pass@roundhouse.proxy.rlwy.net:port/railway
```

> **Note:** When using `DATABASE_URL`, all `DB_HOST`/`DB_PORT`/etc vars are ignored. SSL is enabled by default for cloud providers. Set `DB_SSL=false` to disable if needed.

### Step 3: Configure environment

```bash
cp env.example .env
```

Edit `.env` with your values. At minimum:

```env
# Postgres — match your local setup
DB_USER=your_username
DB_PASSWORD=your_password

# Pick your LLM provider
LLM_PROVIDER=ollama    # or: openai, anthropic, grok

# Team phone numbers
PHONE_UTKARSH=+91XXXXXXXXXX
```

### Step 4: Set up LLM provider

Pick **one** provider and configure it:

#### Ollama (local, free, recommended for dev)
```bash
ollama serve                  # start the server
ollama pull llama3.2          # pull model (~2GB)
```

```env
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

#### OpenAI
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

#### Anthropic (Claude)
```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

#### Grok (xAI)
```env
LLM_PROVIDER=grok
GROK_API_KEY=xai-...
GROK_MODEL=grok-3-mini
```

### Step 5: Build the frontend

```bash
cd frontend
npm run build
cd ..
```

### Step 6: Start the services

```bash
# Terminal 1 — Dashboard API + frontend (http://localhost:3000)
node server.js

# Terminal 2 — WhatsApp ingestion
node ingest.js
# First run: scan the QR code in terminal with your WhatsApp
# Session persists in ./auth_state/ for subsequent runs
```

---

## Development

For frontend development with hot reload:

```bash
# Terminal 1 — API server
node server.js

# Terminal 2 — Vite dev server (http://localhost:5173, proxies /api → :3000)
cd frontend
npm run dev
```

---

## How It Works

### Message flow
1. WhatsApp message arrives via Baileys
2. `ingest.js` registers the source (DM/group) in `wa_sources`
3. If the source is **tracked**, the message is stored and triaged by the LLM
4. LLM returns: category, priority, summary, context, draft response
5. A task is created; if `critical`, managers get an instant WhatsApp alert

### Source management
- All incoming DMs and groups appear in the **Sources** tab automatically
- Utkarsh (super admin) marks which sources to **track** and links them to clients
- Multiple sources (DMs, groups, different phone numbers) can be linked to a **single client**
- Clients can be **merged** if duplicates are discovered

### Triage categories
| Category          | Description                                      |
|-------------------|--------------------------------------------------|
| `urgent_issue`    | Production down, sessions broken, immediate impact |
| `bug_report`      | Something isn't working, not immediately critical  |
| `feature_request` | Client wants a new capability                      |
| `billing_question`| Invoice, payment, subscription queries             |
| `general_query`   | Check-ins, roadmap questions, general chat         |
| `onboarding_help` | New client needs setup assistance                  |

---

## API Endpoints

| Method | Endpoint                        | Description                          |
|--------|---------------------------------|--------------------------------------|
| GET    | `/api/metrics`                  | Dashboard summary metrics            |
| GET    | `/api/clients`                  | Client list with health overview     |
| GET    | `/api/clients/:id/messages`     | Unified conversation for a client    |
| GET    | `/api/clients/:id/sources`      | Linked WhatsApp sources for a client |
| POST   | `/api/clients/merge`            | Merge two clients into one           |
| GET    | `/api/tasks`                    | Task queue (filter: ?category=&status=&priority=) |
| PATCH  | `/api/tasks/:id`                | Update task status or assignment     |
| GET    | `/api/sources`                  | All discovered WhatsApp sources      |
| PATCH  | `/api/sources/:id`              | Track/untrack a source               |
| POST   | `/api/sources/:id/track`        | Track + auto-create client           |
| POST   | `/api/sources/:id/link`         | Link source to existing client       |
| GET    | `/api/team`                     | Team members list                    |

---

## Team Structure

| Name     | Role        | Access                     |
|----------|-------------|----------------------------|
| Utkarsh  | Super Admin | Full access, source mgmt   |
| Mubeen   | Manager     | Dashboard + alerts         |
| Rahul    | POC         | Assigned clients + tasks   |
| Sandhya  | POC         | Assigned clients + tasks   |

---

## Deployment (Production)

### Option A: Dedicated machine / VPS

```bash
# 1. Install prerequisites
#    Node.js 18+, PostgreSQL 14+, Ollama (if using local LLM)

# 2. Clone, install, build
git clone https://github.com/ug911/antiwaca.git && cd antiwaca
npm install
cd frontend && npm install && npm run build && cd ..

# 3. Set up Postgres
createdb wise_tracker
psql wise_tracker < schema.sql

# 4. Configure .env
cp env.example .env
# Edit with production values

# 5. Run with a process manager
npm install -g pm2
pm2 start server.js --name wise-dashboard
pm2 start ingest.js --name wise-ingest
pm2 save
pm2 startup    # auto-start on reboot
```

### Option B: Docker (coming soon)

A `docker-compose.yml` with Postgres + app services is planned.

### Reverse proxy (optional)

If exposing the dashboard externally, put nginx or Caddy in front:

```nginx
server {
    server_name tracker.yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Troubleshooting

| Issue                          | Fix                                                     |
|--------------------------------|---------------------------------------------------------|
| QR code not appearing          | Delete `./auth_state/` and restart `ingest.js`          |
| Ollama connection refused      | Run `ollama serve` first, then `ollama pull <model>`    |
| Postgres connection error      | Check `DB_USER`/`DB_PASSWORD` in `.env`, ensure service is running |
| `LLM_PROVIDER` error           | Must be one of: `ollama`, `openai`, `anthropic`, `grok` |
| Frontend shows blank page      | Run `cd frontend && npm run build` then restart server  |
| WhatsApp disconnects           | Normal — `ingest.js` auto-reconnects. If logged out, re-scan QR |
