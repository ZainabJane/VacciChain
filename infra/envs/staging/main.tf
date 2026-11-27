terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # Partial backend configuration. The concrete bucket/region/key are supplied
  # at init time via `-backend-config=staging.backend.hcl` (or equivalent),
  # so no state location or credentials are committed to source control.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID that owns the staging environment resources."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for the staging environment."
  default     = "us-east-1"
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be a valid AWS region identifier (e.g. us-east-1)."
  }
}

variable "state_bucket" {
  type        = string
  description = "S3 bucket holding Terraform state for this environment (supplied via backend config)."
  validation {
    condition     = length(var.state_bucket) > 0
    error_message = "state_bucket must be provided and non-empty."
  }
}

variable "state_key" {
  type        = string
  description = "S3 object key for this environment's Terraform state (supplied via backend config)."
  validation {
    condition     = length(var.state_key) > 0 && !can(regex("prod", var.state_key))
    error_message = "state_key must be non-empty and must not reference production state."
  }
}

variable "environment" {
  type        = string
  description = "Deployment environment name."
  default     = "staging"
  validation {
    condition     = var.environment == "staging"
    error_message = "This configuration only supports the staging environment."
  }
}

variable "backend_image"   { type = string }
variable "frontend_image"  { type = string }
variable "analytics_image" { type = string }

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

locals {
  env = var.environment
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
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }
output "environment"  { value = local.env }
output "aws_region"   { value = var.aws_region }
output "aws_account_id" { value = var.aws_account_id }
