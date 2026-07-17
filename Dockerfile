FROM alpine:latest

RUN apk add --no-cache nodejs npm ca-certificates

RUN addgroup app && adduser app -G app -D
WORKDIR /home/app
USER app

COPY --chown=app:app package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --include=optional \
    && node -e "import('impit').then(m => console.log('impit OK:', Object.keys(m)))" \
    && rm -rf ~/.npm

COPY --chown=app:app . ./

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
