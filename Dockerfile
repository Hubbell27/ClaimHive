# ClaimHive: one image for the web app, the worker and the migration task.
#   web:     npm start            (default)
#   worker:  npm run worker
#   migrate: npx prisma migrate deploy && npm run readiness
FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Placeholders so prisma generate / next build can load their config; nothing connects at build time.
ENV MIGRATION_DATABASE_URL=postgresql://build@localhost:5432/build DATABASE_URL=postgresql://build@localhost:5432/build
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Amazon RDS CA bundle, for DATABASE_URL=...?sslmode=verify-full&sslrootcert=/etc/ssl/rds-global-bundle.pem
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
