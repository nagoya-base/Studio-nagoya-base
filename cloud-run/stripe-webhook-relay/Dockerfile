# Stripe Webhook中継（Issue #341 PR-C）のCloud Runコンテナ定義。
# このDockerfile自体は本番イメージのビルド・デプロイには使っていない
# （本Issueの範囲では「コードの提供のみ」。実際のビルド・デプロイはオーナーの明示承認後）。
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
