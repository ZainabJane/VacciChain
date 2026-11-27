FROM node:18.18.2-alpine@sha256:9c0a1b8e6f4d2c3b5a7e8f9d0c1b2a3e4f5d6c7b8a9e0f1d2c3b4a5e6f7d8c9b AS builder

# Base image pinning policy:
# - All base images are pinned to immutable digests for reproducible builds.
# - Digests are reviewed and bumped on a monthly cadence (first week of each month),
#   and immediately for critical security advisories.
# - Renovate manages digest bumps via automated pull requests; do not edit digests manually.

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build



FROM nginx:1.25.3-alpine@sha256:4d1e2f3a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e

COPY --from=builder /app/dist /usr/share/nginx/html


COPY nginx.conf /etc/nginx/conf.d/default.conf


RUN chown -R nginx:nginx /usr/share/nginx/html \
    && chown -R nginx:nginx /var/cache/nginx \
    && chown -R nginx:nginx /var/log/nginx \
    && chown -R nginx:nginx /etc/nginx/conf.d \
    && touch /var/run/nginx.pid \
    && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]