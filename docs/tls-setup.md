# TLS / HTTPS Setup Guide

This document describes how to configure TLS termination for VacciChain in production.

## Overview

VacciChain enforces HTTPS in production via:
- **TLS 1.2+ only** (TLS 1.0/1.1 disabled)
- **HTTP → HTTPS redirect** (301 permanent)
- **HSTS header** with 1-year max-age and includeSubDomains
- **Automatic certificate renewal** via Let's Encrypt / Certbot

## Prerequisites

- A registered domain name pointing to your server's public IP
- Ports 80 and 443 open in your firewall
- Docker and Docker Compose installed

## Option 1: Let's Encrypt (Recommended)

### Initial Certificate Issuance

1. **Update nginx.conf** with your domain:
   ```bash
   # Replace server_name _ with your actual domain
   sed -i 's/server_name _;/server_name vaccichain.example.com;/' frontend/nginx.conf
   ```

2. **Obtain certificate** (interactive):
   ```bash
   docker compose run --rm certbot certonly \
     --webroot \
     --webroot-path=/var/www/certbot \
     --email admin@example.com \
     --agree-tos \
     --no-eff-email \
     -d vaccichain.example.com
   ```

3. **Start services**:
   ```bash
   docker compose up -d
   ```

### Automatic Renewal

The `certbot` service runs a renewal check every 12 hours. Certificates are renewed automatically 30 days before expiry.

To force a renewal test:
```bash
docker compose exec certbot certbot renew --dry-run
```

### Certificate Locations

Certificates are stored in `./certs/` (mounted from `/etc/letsencrypt` in the certbot container):
- `./certs/live/<domain>/fullchain.pem` → nginx `ssl_certificate`
- `./certs/live/<domain>/privkey.pem` → nginx `ssl_certificate_key`

Update `frontend/nginx.conf` if your paths differ:
```nginx
ssl_certificate     /etc/nginx/certs/live/vaccichain.example.com/fullchain.pem;
ssl_certificate_key /etc/nginx/certs/live/vaccichain.example.com/privkey.pem;
```

## Option 2: Custom Certificates

If using your own PKI or a commercial CA:

1. **Place certificates** in `./certs/`:
   ```
   ./certs/
   ├── fullchain.pem  # Certificate + intermediate chain
   └── privkey.pem    # Private key
   ```

2. **Set permissions**:
   ```bash
   chmod 600 ./certs/privkey.pem
   chmod 644 ./certs/fullchain.pem
   ```

3. **Update docker-compose.yml** to remove the certbot service (optional).

4. **Start services**:
   ```bash
   docker compose up -d
   ```

## Option 3: AWS ALB with Managed Certificate (ACM) — Production Default

Production terminates public HTTP(S) at an AWS Application Load Balancer using a
certificate managed by **AWS Certificate Manager (ACM)**. ACM issues the
certificate, renews it automatically before expiry, and requires no manual
renewal jobs or certbot containers.

### 1. Request the certificate (DNS validation)

1. **Request a public certificate** in ACM for your domain (and `*.` wildcard if needed):
   ```bash
   aws acm request-certificate \
     --domain-name vaccichain.example.com \
     --validation-method DNS \
     --subject-alternative-names www.vaccichain.example.com
   ```
2. **Create the DNS validation record** shown in the ACM console (or via
   `aws acm describe-certificate`). If DNS is hosted in Route 53, use
   "Create records in Route 53" for one-click validation.
3. **Wait for status `ISSUED`**:
   ```bash
   aws acm describe-certificate \
     --certificate-arn <cert-arn> \
     --query 'Certificate.Status'
   # Expected: "ISSUED"
   ```

ACM renews the certificate automatically as long as the DNS validation record
remains in place — do not delete it. No renewal cron or certbot service is needed.

### 2. Configure the ALB listeners

- **HTTPS listener (443)**: attach the ACM certificate and set the security policy
  to a modern policy, e.g. `ELBSecurityPolicy-TLS13-1-2-2021-06`
  (TLS 1.3 + TLS 1.2, forward-secret ciphers only; TLS 1.0/1.1 disabled).
- **HTTP listener (80)**: do **not** forward to the target group. Instead add a
  rule that redirects all traffic to HTTPS:
  ```
  Default action: Redirect
    Protocol: HTTPS
    Port: 443
    Status code: HTTP_301
  ```
  This makes plaintext application traffic explicitly redirected rather than served.

Example (AWS CLI):
```bash
# HTTPS listener with managed cert + modern policy
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> \
  --protocol HTTPS --port 443 \
  --certificates CertificateArn=<cert-arn> \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=<tg-arn>

# HTTP listener that redirects to HTTPS
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> \
  --protocol HTTP --port 80 \
  --default-actions '[{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}]'
```

### 3. Application (nginx) behind the ALB

1. **Update nginx.conf** to listen on port 80 only (remove the HTTPS server block);
   TLS is terminated at the ALB.
2. **Trust X-Forwarded-Proto** header from the load balancer:
   ```nginx
   # In each proxy_pass location:
   proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
   ```
3. **Verify HSTS** is set by the load balancer (or add it to nginx).
4. **Restrict the target group** so instances only accept traffic from the ALB
   security group (no direct public access on 80/443).

## Verification

### 1. Check HTTPS redirect
```bash
curl -I http://vaccichain.example.com
# Expected: HTTP/1.1 301 Moved Permanently
# Location: https://vaccichain.example.com/
```

### 2. Check TLS version
```bash
openssl s_client -connect vaccichain.example.com:443 -tls1_1
# Expected: handshake failure (TLS 1.1 disabled)

openssl s_client -connect vaccichain.example.com:443 -tls1_2
# Expected: successful connection
```

### 3. Check HSTS header
```bash
curl -I https://vaccichain.example.com
# Expected: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

### 4. Verify the managed certificate (ACM)

```bash
# Certificate is issued and not expired
aws acm describe-certificate \
  --certificate-arn <cert-arn> \
  --query 'Certificate.{Status:Status,NotAfter:NotAfter,Domain:DomainName}'
# Expected: Status "ISSUED", NotAfter in the future

# Certificate served by the ALB matches the ACM certificate
echo | openssl s_client -connect vaccichain.example.com:443 -servername vaccichain.example.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
# Expected: subject CN=vaccichain.example.com, issuer Amazon, notAfter in the future
```

### 5. Verify TLS policy enforcement (ALB)

```bash
# TLS 1.0 / 1.1 must fail (disabled by the security policy)
openssl s_client -connect vaccichain.example.com:443 -tls1_1
# Expected: handshake failure

# TLS 1.2 / 1.3 must succeed
openssl s_client -connect vaccichain.example.com:443 -tls1_2
openssl s_client -connect vaccichain.example.com:443 -tls1_3
# Expected: successful connection
```

### 6. SSL Labs test
Visit [SSL Labs](https://www.ssllabs.com/ssltest/) and enter your domain. Target grade: **A** or **A+**.

## Security Considerations

- **Private key protection**: Never commit `privkey.pem` to version control. Use `.gitignore` or secrets management.
- **Certificate expiry**: Monitor expiry dates. Let's Encrypt certs expire after 90 days.
- **HSTS preload**: After 1 year of stable HTTPS, submit your domain to the [HSTS preload list](https://hstspreload.org/).
- **OCSP stapling**: Enabled by default in `nginx.conf` for faster TLS handshakes.

## Troubleshooting

### "Certificate not found" error
- Ensure `./certs/fullchain.pem` and `./certs/privkey.pem` exist.
- Check file permissions (nginx user must be able to read them).
- Verify volume mount in `docker-compose.yml`.

### HTTPS not working
- Check firewall rules (port 443 must be open).
- Verify DNS points to your server's public IP.
- Check nginx logs: `docker compose logs frontend`

### Certificate renewal fails
- Ensure port 80 is accessible (required for ACME challenge).
- Check certbot logs: `docker compose logs certbot`
- Verify `/.well-known/acme-challenge/` is served correctly:
  ```bash
  curl http://vaccichain.example.com/.well-known/acme-challenge/test
  ```

## Production Checklist

- [ ] Domain DNS configured
- [ ] Firewall allows ports 80 and 443
- [ ] ACM certificate issued (status `ISSUED`) with DNS validation record retained
- [ ] ALB HTTPS listener (443) uses the ACM certificate
- [ ] ALB security policy is modern (e.g. `ELBSecurityPolicy-TLS13-1-2-2021-06`)
- [ ] HTTP listener (80) redirects to HTTPS (301) — no plaintext forwarding
- [ ] HSTS header present with 1-year max-age
- [ ] TLS 1.2+ enforced (1.0/1.1 disabled)
- [ ] SSL Labs grade A or A+
- [ ] Certificate auto-renewal confirmed (ACM managed; DNS validation record present)
- [ ] Private key secured (not in git)
- [ ] Monitoring alerts for certificate expiry (ACM expiry CloudWatch alarm)

## References

- [AWS Certificate Manager Documentation](https://docs.aws.amazon.com/acm/)
- [ALB HTTPS Listeners & Security Policies](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/)
- [OWASP TLS Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Protection_Cheat_Sheet.html)
