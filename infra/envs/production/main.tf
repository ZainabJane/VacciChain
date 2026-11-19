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
}

variable "aws_region"      { type = string; default = "us-east-1" }
variable "backend_image"   { type = string }
variable "frontend_image"  { type = string }
variable "analytics_image" { type = string }

variable "domain_name" {
  type        = string
  description = "Public DNS name for the production application"
  default     = "app.vaccichain.example.com"
}

variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone ID used for ACM DNS validation"
}

locals {
  env = "production"

  # Environment-specific private service discovery endpoints.
  backend_service_url   = "http://backend.${local.env}.vaccichain.internal:8080"
  analytics_service_url = "http://analytics.${local.env}.vaccichain.internal:8080"

  # Least-privilege IAM policy for Terraform remote state access.
  tfstate_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TfStateBucketList"
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetBucketVersioning", "s3:GetBucketLocation"]
        Resource = ["arn:aws:s3:::vaccichain-tfstate"]
      },
      {
        Sid    = "TfStateObjectAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = ["arn:aws:s3:::vaccichain-tfstate/production/terraform.tfstate"]
      },
      {
        Sid    = "TfStateKmsAccess"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = ["*"]
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.us-east-1.amazonaws.com" }
        }
      },
      {
        Sid    = "TfStateLockAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ]
        Resource = ["arn:aws:dynamodb:us-east-1:*:table/vaccichain-tfstate-lock"]
      },
    ]
  })
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

# Managed TLS certificate with automatic DNS validation and renewal.
resource "aws_acm_certificate" "app" {
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

resource "aws_route53_record" "app_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
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

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.app_cert_validation : record.fqdn]
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
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "certificate_arn" { value = aws_acm_certificate_validation.app.certificate_arn }

output "tfstate_iam_policy" {
  value       = local.tfstate_policy
  description = "Least-privilege IAM policy for Terraform remote state access"
}