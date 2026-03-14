FROM node:20-alpine
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install

# Copy source (node_modules excluded via .dockerignore)
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
