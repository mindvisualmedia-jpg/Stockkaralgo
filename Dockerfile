FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7777
ENV HOST=0.0.0.0
ENV STOCKKAR_DATA_DIR=/app/data

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY index.html ./
COPY config.js ./
COPY setup.html ./
COPY aws-backend-cloudformation.yml ./

RUN mkdir -p /app/data

EXPOSE 7777

CMD ["node", "server.js"]
