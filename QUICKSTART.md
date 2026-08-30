# 🚀 Quick Start & Setup Guide

This guide will walk you through setting up and running the entire **LinkedIn Hyper-V** enterprise automation platform from scratch.

---

## 📁 Repository Structure Overview

```
linkedin-hyper-v-modernization/
├── frontend/             # Next.js Dashboard & Control Plane UI
├── backend/              # TypeScript Background Automation & Outbox Engine
├── database/             # Prisma Schema & PostgreSQL ORM
├── packages/
│   └── shared/           # @shared/types domain models and IPC event contracts
├── deployment/           # Dockerfiles, Nomad job specs, and environment configs
├── docker-compose.yml    # Full-stack container orchestration
└── tests/                # Automated unit and integration test suites
```

---

## ⚡ Quickest Start (Docker Compose — 1 Command)

If you have **Docker & Docker Compose** installed, you can boot the entire ecosystem (PostgreSQL, Redis, Auto DB Migrations, Backend Worker, and Frontend UI) in a single command:

```bash
# 1. Clone the repository
git clone https://github.com/Arunjadhav0101/linkedin-hyper-v-modernization.git
cd linkedin-hyper-v-modernization

# 2. Launch all services
docker compose up --build -d
```

### Checking Container Health:
```bash
# View live container status
docker compose ps

# Stream logs
docker compose logs -f
```

* **Frontend Dashboard:** [http://localhost:3000](http://localhost:3000)
* **Backend Health Probe:** [http://localhost:8088/healthz](http://localhost:8088/healthz)
* **Backend Metrics:** [http://localhost:8088/metrics](http://localhost:8088/metrics)

---

## 📋 Manual Setup & Development Prerequisites

If running directly on your host machine without Docker Compose, ensure you have:
- **Node.js**: `v20.0.0` or higher ([Download Node.js](https://nodejs.org/))
- **npm**: `v10.0.0` or higher (bundled with Node.js)
- **PostgreSQL**: `v15` or higher (or Docker)
- **Redis**: `v7` or higher (or Docker)
- **Git**: Latest version

---

## ⚙️ Step-by-Step Manual Setup

### 1. Configure Environment Variables

Copy the example blueprint into your local `.env` file:

**On Linux / macOS / Git Bash:**
```bash
cp deployment/env/.env.example .env
```

**On Windows (PowerShell):**
```powershell
Copy-Item deployment/env/.env.example .env
```

#### Key Variables in `.env`:
```env
# Node Environment & Logging
NODE_ENV=development
LOG_LEVEL=info

# Database Connection (PostgreSQL)
DATABASE_URL="postgresql://postgres:password@localhost:5432/linkedin_hyper_v?schema=public"

# Redis Broker (Token buckets & event streams)
REDIS_URL="redis://localhost:6379"

# Ports
PORT=3000
HEALTH_PORT=8088
```

---

### 2. Install Monorepo Dependencies

Install dependencies across all workspaces (`packages/shared`, `backend`, and `frontend`):

```bash
npm install
```

---

### 3. Build Shared Contracts & Generate Database Client

Build the `@shared/types` contract layer and generate the Prisma ORM client from `database/`:

```bash
# 1. Compile Shared Types contract layer
npm run build --workspace=@shared/types

# 2. Generate Prisma Client bindings
npx prisma generate --schema=database/schema.prisma

# 3. (Optional) Sync database schema with PostgreSQL
npx prisma db push --schema=database/schema.prisma
```

---

### 4. Validate Type Safety & Run Tests

Run the automated verification suite to ensure 100% type safety and module health:

```bash
# Verify strict TypeScript type checking across all workspaces
npm run typecheck

# Run automated unit & integration test suite (Vitest)
npm test
```

---

## 🏃 Running the Application

### Option A: Development Mode (Hot Reloading)

Open two terminal windows:

#### Terminal 1 — Next.js Frontend Dashboard:
```bash
npm run frontend:dev
```
> Access dashboard at: **[http://localhost:3000](http://localhost:3000)**

#### Terminal 2 — Backend Engine (Background Automation & Health Probes):
```bash
# On Linux / macOS / Git Bash:
HEALTH_PORT=8088 npm run backend:dev

# On Windows (PowerShell):
$env:HEALTH_PORT="8088"; npm run backend:dev
```
> Backend health probe active at: **[http://localhost:8088/healthz](http://localhost:8088/healthz)**

---

### Option B: Production Mode

Build and start the compiled standalone production bundles:

```bash
# 1. Build all packages and applications
npm run build

# 2. Start the production Next.js frontend
npm start --workspace=frontend

# 3. In another terminal, start the production Backend engine
HEALTH_PORT=8088 npm start --workspace=backend
```

---

## 🌐 Endpoints & Verification Reference

| Service | Port | Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Control Plane UI** | `3000` | [http://localhost:3000](http://localhost:3000) | Web Dashboard & Account Management |
| **API Health Status** | `3000` | [http://localhost:3000/api/health](http://localhost:3000/api/health) | Full system health check (DB/Redis status) |
| **Message Deduplication** | `3000` | `POST /api/maintenance/messages/dedupe` | Trigger transactional message deduplication |
| **Backend Health Probe** | `8088` | [http://localhost:8088/healthz](http://localhost:8088/healthz) | Backend liveness probe |
| **Backend System Metrics** | `8088` | [http://localhost:8088/metrics](http://localhost:8088/metrics) | Real-time proxy pool stats & queue depth |

---

## 🛠️ Troubleshooting & FAQs

### 1. `Error: listen EADDRINUSE: address already in use :::8080`
- **Cause**: Another service is using port `8080`.
- **Solution**: Run the backend with a custom port by setting `HEALTH_PORT=8088` (e.g. `$env:HEALTH_PORT="8088"; npm run backend:dev`).

### 2. `Cannot find module '@shared/types'`
- **Cause**: The shared contract layer has not been compiled yet.
- **Solution**: Run `npm run build --workspace=@shared/types`.

### 3. `Environment variable not found: DATABASE_URL`
- **Cause**: `.env` file is missing.
- **Solution**: Copy `deployment/env/.env.example` to `.env`.
