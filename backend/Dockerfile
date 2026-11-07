FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production --registry=https://registry.npmmirror.com
COPY src ./src
COPY admin ./admin
RUN mkdir -p uploads/route
EXPOSE 48081
CMD ["node", "src/server.js"]
