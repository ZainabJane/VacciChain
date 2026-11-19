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

variable "domain_name" {
  type        = string
  description = "Public DNS name served by the load balancer (e.g. staging.vaccichain.example.com)."
}

variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone ID used for ACM DNS validation and the public alias record."
}

variable "tls_policy" {
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  description = "Modern ALB TLS security policy (TLS 1.2+ with TLS 1.3 preferred)."
}

locals {
  env = "staging"

  # Environment-specific private backend endpoint for the analytics service.
  # Resolved via the private service discovery namespace, never loopback.
  analytics_backend_url = "http://backend.${local.env}.vaccichain.internal:8080"
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
  backend_image   = var.backend_image
  frontend_image  = var.frontend_image
  analytics_image = var.analytics_image
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
}

# Public alias record pointing at the load balancer.
resource "aws_route53_record" "app" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = module.ecs.alb_dns_name
    zone_id                = module.ecs.alb_zone_id
    evaluate_target_health = true
  }
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "app_url" {
  value       = "https://${var.domain_name}"
  description = "Public HTTPS endpoint for the staging environment."
}

output "certificate_arn" {
  value       = aws_acm_certificate_validation.public.certificate_arn
  description = "Validated ACM certificate ARN used by the HTTPS listener."
}

output "service_discovery_namespace" {
  value       = aws_service_discovery_private_dns_namespace.internal.name
  description = "Private service discovery namespace for internal routing."
}

output "analytics_backend_url" {
  value       = local.analytics_backend_url
  description = "Private backend endpoint used by the analytics service."
}