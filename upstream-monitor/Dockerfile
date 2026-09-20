FROM node:22-alpine

# 安装 docker-cli 以便直接与同一宿主机上的 sub2api-postgres 通信
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node *.js ./
COPY --chown=node:node public ./public

# The named data volume is initialized from this directory and remains writable by the app user.
RUN mkdir -p /app/data && chown -R node:node /app

# 环境变量设置
ENV NODE_ENV=production
ENV PORT=3300
ENV IS_VPS=true

EXPOSE 3300

USER node

CMD ["node", "server.js"]
