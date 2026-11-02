FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY master-brain-mcp/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY master-brain-mcp/server.js ./
COPY master-brain-mcp/public ./public
USER node
EXPOSE 3000
CMD ["npm", "start"]
