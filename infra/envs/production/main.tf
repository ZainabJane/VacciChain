terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket = "vaccichain-tfstate"
    key    = "production/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region"      { type = string; default = "us-east-1" }

variable "backend_image" {
  type        = string
  description = "Immutable backend image reference pinned by digest (e.g. repo@sha256:...)."

  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.backend_image))
    error_message = "backend_image must be pinned to an immutable digest (repo@sha256:<64 hex chars>); mutable tags are not allowed in production."
  }
}

variable "frontend_image" {
  type        = string
  description = "Immutable frontend image reference pinned by digest (e.g. repo@sha256:...)."

  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.frontend_image))
    error_message = "frontend_image must be pinned to an immutable digest (repo@sha256:<64 hex chars>); mutable tags are not allowed in production."
  }
}

variable "analytics_image" {
  type        = string
  description = "Immutable analytics image reference pinned by digest (e.g. repo@sha256:...)."

  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.analytics_image))
    error_message = "analytics_image must be pinned to an immutable digest (repo@sha256:<64 hex chars>); mutable tags are not allowed in production."
  }
}

variable "backend_image_digest" {
  type        = string
  description = "Expected attested digest for the backend artifact (sha256:<64 hex chars>)."

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.backend_image_digest))
    error_message = "backend_image_digest must be of the form sha256:<64 hex chars>."
  }
}

variable "frontend_image_digest" {
  type        = string
  description = "Expected attested digest for the frontend artifact (sha256:<64 hex chars>)."

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.frontend_image_digest))
    error_message = "frontend_image_digest must be of the form sha256:<64 hex chars>."
  }
}

variable "analytics_image_digest" {
  type        = string
  description = "Expected attested digest for the analytics artifact (sha256:<64 hex chars>)."

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.analytics_image_digest))
    error_message = "analytics_image_digest must be of the form sha256:<64 hex chars>."
  }
}

variable "source_revision" {
  type        = string
  description = "Git commit SHA the release artifacts were built from."

  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_revision))
    error_message = "source_revision must be a full 40-character git commit SHA."
  }
}

variable "build_workflow" {
  type        = string
  description = "Trusted build workflow reference that produced the artifacts (e.g. .github/workflows/release.yml@refs/heads/main)."
}

locals {
  env = "production"

  # Extract the digest portion of each pinned image reference for provenance checks.
  backend_image_digest_actual   = element(split("@", var.backend_image), 1)
  frontend_image_digest_actual  = element(split("@", var.frontend_image), 1)
  analytics_image_digest_actual = element(split("@", var.analytics_image), 1)

  # Provenance metadata recorded alongside the release for auditability.
  provenance = {
    environment     = local.env
    source_revision = var.source_revision
    build_workflow  = var.build_workflow
    artifacts = {
      backend = {
        image  = var.backend_image
        digest = local.backend_image_digest_actual
      }
      frontend = {
        image  = var.frontend_image
        digest = local.frontend_image_digest_actual
      }
      analytics = {
        image  = var.analytics_image
        digest = local.analytics_image_digest_actual
      }
    }
  }
}

# Provenance verification: fail before publishing if the pinned image digest does
# not match the expected attested artifact digest.
resource "terraform_data" "provenance_verification" {
  input = local.provenance

  lifecycle {
    precondition {
      condition     = local.backend_image_digest_actual == var.backend_image_digest
      error_message = "Backend image digest does not match the attested artifact digest; refusing to deploy unverified provenance."
    }
    precondition {
      condition     = local.frontend_image_digest_actual == var.frontend_image_digest
      error_message = "Frontend image digest does not match the attested artifact digest; refusing to deploy unverified provenance."
    }
    precondition {
      condition     = local.analytics_image_digest_actual == var.analytics_image_digest
      error_message = "Analytics image digest does not match the attested artifact digest; refusing to deploy unverified provenance."
    }
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

  depends_on = [terraform_data.provenance_verification]
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "release_provenance" {
  value       = local.provenance
  description = "Provenance metadata for the deployed release artifacts."
}