FROM python:3.11-slim@sha256:8b1e7c3f9a2d4e6f0b8c1a3d5e7f9b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a AS builder
# Base image pinned by digest for reproducibility.
# Update cadence: reviewed monthly and on security advisories.
# Managed by Renovate (see renovate.json) which opens PRs for digest updates.
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.11-slim@sha256:8b1e7c3f9a2d4e6f0b8c1a3d5e7f9b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a AS production
# Base image pinned by digest for reproducibility.
# Update cadence: reviewed monthly and on security advisories.
# Managed by Renovate (see renovate.json) which opens PRs for digest updates.
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=builder /install /usr/local
COPY . .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8001
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1
CMD ["gunicorn", "main:app", "--config", "gunicorn.conf.py"]