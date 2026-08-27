# Multi-Stage Alpine Dockerfile for Next.js App
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# Step 1: Install dependencies
FROM base AS dependencies
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY app/package.json ./app/
COPY prisma ./prisma
RUN npm ci

# Step 2: Build the application
FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED 1
ENV DATABASE_URL="postgresql://postgres:password@localhost:5432/linkedin_hyper_v?schema=public"
RUN npm run build --workspace=@shared/types
RUN npx prisma generate
RUN npm run build --workspace=app

# Step 3: Minimal production runtime
FROM base AS runner
ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs

COPY --from=builder /app/app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/app/.next/static ./.next/static

EXPOSE 3000
ENV PORT 3000
CMD ["node", "server.js"]
