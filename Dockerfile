# syntax=docker/dockerfile:1

# Use a lightweight Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy dependency manifests
COPY package.json ./

# Install production dependencies

RUN npm config set registry https://registry.npmmirror.com && npm install --only=production

# Copy application source
COPY . .

# Expose the default agent port
EXPOSE 3774

# Start the Watchlog Agent
CMD ["node", "watchlog-agent.js"]