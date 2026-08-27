# 🚀 Quick Start & Setup Guide

This guide will walk you through setting up and running the **LinkedIn Hyper-V** enterprise automation platform from scratch.

---

## 📋 Prerequisites

Ensure you have the following installed on your system:
- **Node.js**: `v20.0.0` or higher ([Download Node.js](https://nodejs.org/))
- **npm**: `v10.0.0` or higher (bundled with Node.js)
- **PostgreSQL**: `v15` or higher (or Docker)
- **Redis**: `v7` or higher (or Docker)
- **Git**: Latest version

---

## ⚙️ Step-by-Step Setup from Scratch

### 1. Clone the Repository

```bash
git clone https://github.com/Arunjadhav0101/linkedin-hyper-v-modernization.git
cd linkedin-hyper-v-modernization
```

---

### 2. Configure Environment Variables

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

### 3. Install Monorepo Dependencies

Install dependencies across all workspaces (`packages/shared`, `worker`, and `app`):

```bash
npm install
```

---

### 4. Build Shared Contracts & Generate Database Client

Build the `@shared/types` contract layer and generate the Prisma ORM client:

```bash
# 1. Compile Shared Types contract layer
npm run build --workspace=@shared/types

# 2. Generate Prisma Client bindings
npx prisma generate

# 3. (Optional) Sync database schema with PostgreSQL
npx prisma db push
```

---

### 5. Validate Type Safety & Run Tests

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

#### Terminal 1 — Next.js Dashboard & Control Plane:
```bash
npm run app:dev
```
> Access dashboard at: **[http://localhost:3000](http://localhost:3000)**

#### Terminal 2 — Worker Engine (Background Automation & Health Probes):
```bash
# On Linux / macOS / Git Bash:
HEALTH_PORT=8088 npm run worker:dev

# On Windows (PowerShell):
$env:HEALTH_PORT="8088"; npm run worker:dev
```
> Worker health probe active at: **[http://localhost:8088/healthz](http://localhost:8088/healthz)**

---

### Option B: Production Mode

Build and start the compiled standalone production bundles:

```bash
# 1. Build all packages and applications
npm run build

# 2. Start the production Next.js application
npm start --workspace=app

# 3. In another terminal, start the production Worker engine
HEALTH_PORT=8088 npm start --workspace=worker
```

---

### Option C: Docker Deployment

You can build and run individual multi-stage Alpine containers:

#### Build Worker Image:
```bash
docker build -f deployment/docker/Dockerfile.worker -t linkedin-worker:latest .
docker run -d --name linkedin-worker -p 8088:8080 --env-file .env linkedin-worker:latest
```

#### Build Next.js App Image:
```bash
docker build -f deployment/docker/Dockerfile.app -t linkedin-app:latest .
docker run -d --name linkedin-app -p 3000:3000 --env-file .env linkedin-app:latest
```

---

## 🌐 Endpoints & Verification Reference

| Service | Port | Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Control Plane UI** | `3000` | [http://localhost:3000](http://localhost:3000) | Web Dashboard & Account Management |
| **API Health Status** | `3000` | [http://localhost:3000/api/health](http://localhost:3000/api/health) | Full system health check (DB/Redis status) |
| **Message Deduplication** | `3000` | `POST /api/maintenance/messages/dedupe` | Trigger transactional message deduplication |
| **Worker Health Probe** | `8088` | [http://localhost:8088/healthz](http://localhost:8088/healthz) | Worker liveness probe |
| **Worker System Metrics** | `8088` | [http://localhost:8088/metrics](http://localhost:8088/metrics) | Real-time proxy pool stats & queue depth |

---

## 🛠️ Troubleshooting & FAQs

### 1. `Error: listen EADDRINUSE: address already in use :::8080`
- **Cause**: Another service is using port `8080`.
- **Solution**: Run the worker with a custom port by setting `HEALTH_PORT=8088` (e.g. `$env:HEALTH_PORT="8088"; npm run worker:dev`).

### 2. `Cannot find module '@shared/types'`
- **Cause**: The shared contract layer has not been compiled yet.
- **Solution**: Run `npm run build --workspace=@shared/types`.

### 3. `Environment variable not found: DATABASE_URL`
- **Cause**: `.env` file is missing.
- **Solution**: Copy `deployment/env/.env.example` to `.env`.
