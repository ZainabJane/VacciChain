terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket         = "vaccichain-tfstate"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "alias/vaccichain-tfstate"
    dynamodb_table = "vaccichain-tfstate-lock"
  }
}

provider "aws" {
  region = var.aws_region

  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "vaccichain"
      ManagedBy   = "terraform"
    }
  }
}

variable "aws_account_id" {
  description = "AWS account ID for the production environment. Must be a 12-digit number."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "AWS region for the production environment."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be a valid AWS region identifier (e.g. us-east-1)."
  }
}

variable "state_bucket" {
  description = "S3 bucket holding Terraform remote state for the production environment."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket))
    error_message = "state_bucket must be a valid S3 bucket name."
  }
}

variable "state_key" {
  description = "S3 object key for the production Terraform state file."
  type        = string
  default     = "production/terraform.tfstate"

  validation {
    condition     = can(regex("^production/.+\\.tfstate$", var.state_key))
    error_message = "state_key must live under the production/ prefix and end with .tfstate."
  }
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"

  validation {
    condition     = var.environment == "production"
    error_message = "environment must be \"production\" for this configuration."
  }
}

variable "aws_region"      { type = string; default = "us-east-1" }

# Persistence strategy for the event index (Backlog 052).
# Production uses a multi-writer PostgreSQL backend (RDS) instead of the
# single-writer SQLite index, so that concurrent backend tasks can write
# safely with row-level locking, automated backups, and Multi-AZ failover.
variable "event_index_engine" {
  type        = string
  default     = "postgres"
  description = "Event index persistence backend. Production must use a multi-writer database."
  validation {
    condition     = contains(["postgres"], var.event_index_engine)
    error_message = "Production event index must use the multi-writer 'postgres' backend."
  }
}

variable "event_index_instance_class" {
  type    = string
  default = "db.r6g.large"
}

variable "event_index_allocated_storage" {
  type    = number
  default = 100
}

variable "event_index_backup_retention_days" {
  type    = number
  default = 14
}

# Trust-proxy topology (Backlog 056).
# The backend sits behind a single ALB, so exactly one proxy hop is trusted.
# This must match the deployed load-balancer topology to prevent spoofed
# X-Forwarded-For headers from bypassing rate limits or corrupting audit logs.
variable "trust_proxy_hops" {
  type        = number
  default     = 1
  description = "Number of trusted reverse-proxy hops in front of the backend (ALB = 1)."
  validation {
    condition     = var.trust_proxy_hops >= 0 && var.trust_proxy_hops <= 2
    error_message = "trust_proxy_hops must be between 0 and 2 for the production topology."
  }
}

locals {
  env = "production"

  # Backend task count is gated on the multi-writer database being in place.
  backend_desired_count = 2

  backend_environment = {
    EVENT_INDEX_ENGINE = var.event_index_engine
    TRUST_PROXY_HOPS   = tostring(var.trust_proxy_hops)
  }
}

module "vpc" {
  source   = "../../modules/vpc"
  name     = "vaccichain-${local.env}"
  cidr     = "10.2.0.0/16"
  az_count = 2
}

module "secrets" {
  source = "../../modules/secrets"
  name   = "vaccichain-${local.env}"
}

# Multi-writer event index database with automated backups and Multi-AZ failover.
module "event_index_db" {
  source = "../../modules/rds"

  name                  = "vaccichain-${local.env}-event-index"
  engine                = "postgres"
  instance_class        = var.event_index_instance_class
  allocated_storage     = var.event_index_allocated_storage
  vpc_id                = module.vpc.vpc_id
  private_subnets       = module.vpc.private_subnets
  multi_az              = true
  backup_retention_days = var.event_index_backup_retention_days
  deletion_protection   = true
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
  backend_cpu     = 1024
  backend_memory  = 2048
  desired_count   = local.backend_desired_count

  # Persistence and proxy configuration passed to the backend tasks.
  backend_environment = local.backend_environment
  backend_secret_arns = merge(
    module.secrets.secret_arns,
    { EVENT_INDEX_DATABASE_URL = module.event_index_db.connection_secret_arn }
  )

  # TLS termination on the public ALB.
  certificate_arn     = aws_acm_certificate_validation.app.certificate_arn
  https_listener_port = 443
  http_listener_port  = 80
  ssl_policy          = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  http_redirect       = true

  # Private service discovery for internal routing.
  service_discovery_namespace = "${local.env}.vaccichain.internal"

  # Environment-specific backend endpoints for the analytics service.
  backend_service_url   = local.backend_service_url
  analytics_service_url = local.analytics_service_url

  # Container health checks (Backlog 120)
  backend_health_check_path     = "/health"
  frontend_health_check_path    = "/health"
  analytics_health_check_path   = "/health"
  backend_health_check_grace_period   = 60
  frontend_health_check_grace_period  = 30
  analytics_health_check_grace_period = 60
  health_check_interval         = 30
  health_check_timeout          = 5
  health_check_retries          = 3
  health_check_start_period     = 15

  # Target group health checks
  target_group_health_check_path     = "/health"
  target_group_health_check_interval = 30
  target_group_health_check_timeout  = 5
  target_group_healthy_threshold     = 2
  target_group_unhealthy_threshold   = 3
  target_group_deregistration_delay  = 30

  depends_on = [terraform_data.provenance_verification]
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "event_index_endpoint" {
  value     = module.event_index_db.endpoint
  sensitive = true
}

output "trust_proxy_hops" { value = var.trust_proxy_hops }
