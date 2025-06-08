# syntax=docker/dockerfile:1

# Use a lightweight Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source
COPY . .

# Expose the default agent port
EXPOSE 3774

# Start the Watchlog Agent
CMD ["node", "watchlog-agent.js"]