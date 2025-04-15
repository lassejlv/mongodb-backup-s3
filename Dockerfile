FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb* ./

RUN bun install --frozen-lockfile

COPY . .

RUN mkdir -p backups

ENV NODE_ENV=production

ENTRYPOINT ["bun", "run", "src/index.ts"]
