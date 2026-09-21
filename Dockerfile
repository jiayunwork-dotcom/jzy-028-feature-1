FROM node:20-slim

WORKDIR /app

# 先装全部依赖（利用层缓存）
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并构建
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 只保留生产依赖
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "dist/main.js"]
