terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket = "vaccichain-tfstate"
    key    = "staging/terraform.tfstate"
    region = "us-east-1"
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

locals {
  env = "staging"

  # Validate that the configured image references are pinned to immutable
  # digests rather than mutable tags.
  image_digest_pattern = "^sha256:[0-9a-f]{64}$"

  image_digests = {
    backend   = var.backend_digest
    frontend  = var.frontend_digest
    analytics = var.analytics_digest
  }

  attested_digests = {
    backend   = var.provenance.artifacts.backend
    frontend  = var.provenance.artifacts.frontend
    analytics = var.provenance.artifacts.analytics
  }

  # Images must reference the exact digest that was attested.
  digest_mismatches = [
    for name, digest in local.image_digests : name
    if digest != local.attested_digests[name]
  ]
}

# Enforce immutable digests for all release artifacts.
resource "terraform_data" "artifact_digest_validation" {
  for_each = local.image_digests

  input = each.value

  lifecycle {
    precondition {
      condition     = can(regex(local.image_digest_pattern, each.value))
      error_message = "The ${each.key} image must be pinned to an immutable sha256 digest (got \"${each.value}\")."
    }
  }
}

# Verify artifact provenance before publishing to the environment. Fails if any
# image digest does not match the expected attested artifact.
resource "terraform_data" "provenance_verification" {
  input = {
    source_revision = var.provenance.source_revision
    build_workflow  = var.provenance.build_workflow
    build_run_id    = var.provenance.build_run_id
    digests         = local.image_digests
  }

  lifecycle {
    precondition {
      condition     = length(local.digest_mismatches) == 0
      error_message = "Artifact provenance verification failed: digest mismatch for ${join(", ", local.digest_mismatches)}. Deployment blocked until attested artifacts match."
    }

    precondition {
      condition     = var.provenance.source_revision != "" && var.provenance.build_workflow != ""
      error_message = "Artifact provenance metadata is incomplete: source_revision and build_workflow are required."
    }
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

  depends_on = [
    terraform_data.artifact_digest_validation,
    terraform_data.provenance_verification,
  ]
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "artifact_provenance" {
  value = {
    source_revision = var.provenance.source_revision
    build_workflow  = var.provenance.build_workflow
    build_run_id    = var.provenance.build_run_id
    digests         = local.image_digests
  }
}