# syntax=docker/dockerfile:1
FROM node:26-slim AS build
RUN npm install -g pnpm@12
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
RUN pnpm install --frozen-lockfile --filter @mdh/server --filter @mdh/web
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @mdh/web build && pnpm --filter @mdh/server build
# only the packages the server needs at run time
RUN pnpm --filter @mdh/server deploy --prod --legacy /out && cp -r apps/server/dist /out/dist

FROM node:26-slim
ENV NODE_ENV=production STATIC_DIR=/app/site PORT=3000
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /repo/apps/web/dist ./site
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
