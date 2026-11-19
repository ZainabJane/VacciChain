terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # Backend is intentionally partial. Environment-specific values are supplied at
  # init time via `-backend-config=backend/production.tfbackend` (see infra/README.md).
  # No bucket, key, or region is hardcoded here so environments never share state.
  backend "s3" {}
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

variable "backend_image"   { type = string }
variable "frontend_image"  { type = string }
variable "analytics_image" { type = string }

locals {
  env = var.environment
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
  desired_count   = 2
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }