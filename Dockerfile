FROM node:20-alpine

RUN npm install --global tyc-cli
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY data ./data

ENV NODE_ENV=production
ENV PORT=4173
EXPOSE 4173

CMD ["sh", "-c", "test -n \"$TYC_API_KEY\" && tyc init --authorization \"$TYC_API_KEY\" >/dev/null && node server.js"]
