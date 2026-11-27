terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket         = "vaccichain-tfstate"
    key            = "staging/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "alias/vaccichain-tfstate"
    dynamodb_table = "vaccichain-tfstate-lock"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region"      { type = string; default = "us-east-1" }
variable "backend_image"   { type = string }
variable "frontend_image"  { type = string }
variable "analytics_image" { type = string }

# Immutable artifact digests (sha256:...) produced by the release build.
# These must match the attested artifacts recorded in the provenance metadata.
variable "backend_digest"   { type = string }
variable "frontend_digest"  { type = string }
variable "analytics_digest" { type = string }

# Trusted provenance metadata emitted by the build workflow (e.g. in-toto
# attestation / SLSA provenance). Each entry links an artifact to its source
# revision, build workflow, and dependency inputs.
variable "provenance" {
  type = object({
    source_revision = string
    build_workflow  = string
    build_run_id    = string
    artifacts = object({
      backend   = string
      frontend  = string
      analytics = string
    })
  })
  description = "Trusted provenance metadata for release artifacts (source revision, build workflow, attested digests)."
}

variable "backend_health_check_path" {
  type        = string
  description = "HTTP path used by the backend container and target group health checks"
  default     = "/health"
}

variable "frontend_health_check_path" {
  type        = string
  description = "HTTP path used by the frontend container and target group health checks"
  default     = "/"
}

variable "analytics_health_check_path" {
  type        = string
  description = "HTTP path used by the analytics container and target group health checks"
  default     = "/health"
}

variable "health_check_interval" {
  type        = number
  description = "Seconds between health check probes"
  default     = 30
}

variable "health_check_timeout" {
  type        = number
  description = "Seconds before a health check probe times out"
  default     = 5
}

variable "health_check_healthy_threshold" {
  type        = number
  description = "Consecutive successful probes required to mark a target healthy"
  default     = 2
}

variable "health_check_unhealthy_threshold" {
  type        = number
  description = "Consecutive failed probes required to mark a target unhealthy"
  default     = 3
}

variable "health_check_grace_period" {
  type        = number
  description = "Seconds ECS waits before starting container health checks after task start"
  default     = 60
}

variable "health_check_start_period" {
  type        = number
  description = "Seconds the container health check start period allows for boot before failures count"
  default     = 30
}

variable "health_check_retries" {
  type        = number
  description = "Number of consecutive container health check failures before the container is marked unhealthy"
  default     = 3
}

# Persistence strategy for the event index (backlog #52).
# Staging mirrors production topology: a single ALB fronts the backend, so the
# SQLite-based index is retained here for load/failure analysis. The selected
# multi-writer database option is exercised via the persistence_mode variable.
variable "persistence_mode" {
  type        = string
  default     = "sqlite"
  description = "Event index persistence backend: 'sqlite' (single-writer) or 'postgres' (multi-writer)."
  validation {
    condition     = contains(["sqlite", "postgres"], var.persistence_mode)
    error_message = "persistence_mode must be either 'sqlite' or 'postgres'."
  }
}

# Trust-proxy configuration (backlog #56).
# Staging sits behind exactly one ALB hop, so the backend must trust the
# forwarded headers from that single proxy layer only. This prevents spoofed
# X-Forwarded-For headers from bypassing rate limits or corrupting audit
# attribution.
variable "trust_proxy_hops" {
  type        = number
  default     = 1
  description = "Number of trusted proxy hops in front of the backend (matches ALB topology)."
}

locals {
  env = "staging"

  # Derived trust-proxy setting passed to the backend container. A numeric hop
  # count is used rather than a blanket `true` so only the ALB is trusted.
  trust_proxy_setting = tostring(var.trust_proxy_hops)

  backend_environment = {
    PERSISTENCE_MODE = var.persistence_mode
    TRUST_PROXY      = local.trust_proxy_setting
  }
}

module "vpc" {
  source   = "../../modules/vpc"
  name     = "vaccichain-${local.env}"
  cidr     = "10.1.0.0/16"
  az_count = 2
}

module "secrets" {
  source = "../../modules/secrets"
  name   = "vaccichain-${local.env}"
}

# Private service discovery namespace for internal service-to-service routing.
resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "${local.env}.vaccichain.internal"
  description = "Private service discovery namespace for vaccichain ${local.env}"
  vpc         = module.vpc.vpc_id
}

# Managed ACM certificate with automatic DNS validation/renewal.
resource "aws_acm_certificate" "public" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "vaccichain-${local.env}"
    Environment = local.env
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.public.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.hosted_zone_id
}

resource "aws_acm_certificate_validation" "public" {
  certificate_arn         = aws_acm_certificate.public.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

module "ecs" {
  source          = "../../modules/ecs"
  name            = "vaccichain-${local.env}"
  vpc_id          = module.vpc.vpc_id
  public_subnets  = module.vpc.public_subnets
  private_subnets = module.vpc.private_subnets
  backend_image   = "${var.backend_image}@${var.backend_digest}"
  frontend_image  = "${var.frontend_image}@${var.frontend_digest}"
  analytics_image = "${var.analytics_image}@${var.analytics_digest}"
  secret_arns     = module.secrets.secret_arns
  desired_count   = 1

  # HTTPS listener with managed certificate and modern TLS policy.
  certificate_arn = aws_acm_certificate_validation.public.certificate_arn
  tls_policy      = var.tls_policy

  # Explicit HTTP -> HTTPS redirect (plaintext application traffic rejected).
  http_redirect_to_https = true

  # Private service discovery for analytics -> backend calls.
  service_discovery_namespace_arn  = aws_service_discovery_private_dns_namespace.internal.arn
  service_discovery_namespace_name = aws_service_discovery_private_dns_namespace.internal.name
  analytics_backend_url            = local.analytics_backend_url

  backend_health_check_path   = var.backend_health_check_path
  frontend_health_check_path  = var.frontend_health_check_path
  analytics_health_check_path = var.analytics_health_check_path

  health_check_interval            = var.health_check_interval
  health_check_timeout             = var.health_check_timeout
  health_check_healthy_threshold   = var.health_check_healthy_threshold
  health_check_unhealthy_threshold = var.health_check_unhealthy_threshold
  health_check_grace_period        = var.health_check_grace_period
  health_check_start_period        = var.health_check_start_period
  health_check_retries             = var.health_check_retries

  # Persistence and trust-proxy configuration for the staging topology.
  backend_environment = local.backend_environment
  trust_proxy_hops    = var.trust_proxy_hops
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "persistence_mode" { value = var.persistence_mode }

output "trust_proxy_hops" { value = var.trust_proxy_hops }
