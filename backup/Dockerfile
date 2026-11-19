FROM alpine:3.19@sha256:c5b1261d6d3e43071626931fc004f70149baeba2c8ec672bd4f27761f8e1ad6b

# Base image is pinned to a digest for reproducibility.
# Update cadence: reviewed monthly (and on security advisories) via Renovate,
# which manages this digest and opens PRs for new alpine:3.19 builds.

# Install AWS CLI and tzdata for cron timezone support
RUN apk add --no-cache aws-cli tzdata

WORKDIR /app
COPY backup.sh .
RUN chmod +x backup.sh

# Add crontab entry for daily midnight run
RUN echo "0 0 * * * /app/backup.sh >> /var/log/backup.log 2>&1" > /etc/crontabs/root

# Keep cron running in foreground
CMD ["crond", "-f", "-l", "2"]