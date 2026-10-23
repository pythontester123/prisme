# Prisme — image prête à héberger (Render, Railway, Fly.io, un VPS…)
FROM node:22-bookworm-slim

# LibreOffice débloque Word, PowerPoint, RTF et OpenDocument. Les polices servent aux PDF générés.
# Pour une image plus légère (~400 Mo de moins) : docker build --build-arg WITH_LIBREOFFICE=0 .
ARG WITH_LIBREOFFICE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core fonts-liberation \
 && if [ "$WITH_LIBREOFFICE" = "1" ]; then apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress; fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
RUN chmod +x node_modules/7zip-bin/linux/*/7za

COPY lib ./lib
COPY public ./public
COPY server.js ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    MAX_FILE_MB=500 \
    FILE_TTL_MIN=60

USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
