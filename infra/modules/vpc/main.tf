variable "name"       { type = string }
variable "cidr"       { type = string; default = "10.0.0.0/16" }
variable "az_count"   { type = number; default = 2 }

# Egress allow-list for private ECS tasks (scheduled tasks / polling workers).
# Each entry is a CIDR that tasks are permitted to reach on the given ports.
# Stellar RPC/Horizon providers and internal APIs must be listed here; anything
# not listed is denied by the default egress rule below.
variable "allowed_egress_cidrs" {
  type    = list(string)
  default = []
}

variable "allowed_egress_ports" {
  type    = list(number)
  default = [443]
}

# Internal API ports reachable inside the VPC (e.g. internal service mesh).
variable "internal_api_ports" {
  type    = list(number)
  default = [443]
}

# CIDRs that must never be reachable from private tasks (admin/public ranges).
variable "denied_egress_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "enable_aws_vpc_endpoints" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_availability_zones" "available" { state = "available" }

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = merge({ Name = "${var.name}-vpc" }, var.tags)
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr, 8, count.index + var.az_count)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  count  = var.az_count
  domain = "vpc"
}

resource "aws_nat_gateway" "this" {
  count         = var.az_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-nat-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  # Default route for private subnets goes through the per-AZ NAT gateway so
  # scheduled tasks/pollers can reach approved Stellar RPC/Horizon providers.
  # All other egress is blocked by the private network ACL and task SG.
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[count.index].id
  }
  tags = merge({ Name = "${var.name}-private-rt-${count.index}" }, var.tags)
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---------------------------------------------------------------------------
# Security groups for private ECS tasks (scheduled tasks / polling workers)
# ---------------------------------------------------------------------------

# Security group attached to private ECS tasks. Egress is restricted to the
# explicit allow-list of Stellar RPC/Horizon providers and internal APIs.
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.name}-ecs-tasks"
  description = "Private ECS tasks: restricted egress to Stellar RPC/Horizon and internal APIs"
  vpc_id      = aws_vpc.this.id

  # No ingress: tasks are pull-based workers.
  tags = merge({ Name = "${var.name}-ecs-tasks" }, var.tags)
}

# Allow egress to the approved external destinations (Stellar RPC/Horizon).
resource "aws_vpc_security_group_egress_rule" "allowed_external" {
  for_each = toset(var.allowed_egress_cidrs)

  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Allow egress to approved provider ${each.value}"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = min(var.allowed_egress_ports...)
  to_port           = max(var.allowed_egress_ports...)
}

# Allow egress to internal APIs within the VPC CIDR.
resource "aws_vpc_security_group_egress_rule" "internal_api" {
  for_each = toset([for p in var.internal_api_ports : tostring(p)])

  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Allow egress to internal API port ${each.value}"
  cidr_ipv4         = var.cidr
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

# Allow DNS resolution (UDP/TCP 53) to the VPC resolver so hostnames resolve.
resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Allow DNS resolution (UDP 53) to VPC resolver"
  cidr_ipv4         = "${cidrhost(var.cidr, 2)}/32"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Allow DNS resolution (TCP 53) to VPC resolver"
  cidr_ipv4         = "${cidrhost(var.cidr, 2)}/32"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

# Explicit deny for admin/public ranges. AWS security groups are allow-only,
# so the absence of an allow rule already denies these; this network ACL makes
# the deny explicit and auditable.
resource "aws_network_acl" "private" {
  vpc_id     = aws_vpc.this.id
  subnet_ids = aws_subnet.private[*].id

  # Allow return traffic and internal VPC traffic.
  ingress {
    rule_no    = 100
    action     = "allow"
    protocol   = "-1"
    cidr_block = var.cidr
    from_port  = 0
    to_port    = 0
  }

  # Allow ephemeral return traffic from approved egress destinations.
  dynamic "ingress" {
    for_each = toset(var.allowed_egress_cidrs)
    content {
      rule_no    = 200
      action     = "allow"
      protocol   = "tcp"
      cidr_block = ingress.value
      from_port  = 1024
      to_port    = 65535
    }
  }

  # Deny everything else inbound (including admin/public ranges).
  ingress {
    rule_no    = 900
    action     = "deny"
    protocol   = "-1"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  # Allow internal VPC egress.
  egress {
    rule_no    = 100
    action     = "allow"
    protocol   = "-1"
    cidr_block = var.cidr
    from_port  = 0
    to_port    = 0
  }

  # Allow egress to approved external destinations on allowed ports.
  dynamic "egress" {
    for_each = toset(var.allowed_egress_cidrs)
    content {
      rule_no    = 200
      action     = "allow"
      protocol   = "tcp"
      cidr_block = egress.value
      from_port  = min(var.allowed_egress_ports...)
      to_port    = max(var.allowed_egress_ports...)
    }
  }

  # Deny everything else outbound (admin/public ranges not in the allow-list).
  egress {
    rule_no    = 900
    action     = "deny"
    protocol   = "-1"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = merge({ Name = "${var.name}-private-nacl" }, var.tags)
}

# ---------------------------------------------------------------------------
# VPC endpoints for AWS services (keeps AWS API traffic off the NAT/public path)
# ---------------------------------------------------------------------------

locals {
  vpc_endpoint_services = var.enable_aws_vpc_endpoints ? [
    "com.amazonaws.${data.aws_region.current.name}.ecr.api",
    "com.amazonaws.${data.aws_region.current.name}.ecr.dkr",
    "com.amazonaws.${data.aws_region.current.name}.logs",
    "com.amazonaws.${data.aws_region.current.name}.secretsmanager",
    "com.amazonaws.${data.aws_region.current.name}.ssm",
  ] : []
}

data "aws_region" "current" {}

resource "aws_security_group" "vpc_endpoints" {
  count       = var.enable_aws_vpc_endpoints ? 1 : 0
  name        = "${var.name}-vpc-endpoints"
  description = "Allow private ECS tasks to reach AWS service VPC endpoints"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "HTTPS from private subnets"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    cidr_blocks     = [for s in aws_subnet.private : s.cidr_block]
  }

  tags = merge({ Name = "${var.name}-vpc-endpoints" }, var.tags)
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(local.vpc_endpoint_services)
  vpc_id              = aws_vpc.this.id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = aws_security_group.vpc_endpoints[*].id
  private_dns_enabled = true

  tags = merge({ Name = "${var.name}-${replace(each.value, ".", "-")}" }, var.tags)
}

output "vpc_id"          { value = aws_vpc.this.id }
output "public_subnets"  { value = aws_subnet.public[*].id }
output "private_subnets" { value = aws_subnet.private[*].id }
output "ecs_tasks_security_group_id" { value = aws_security_group.ecs_tasks.id }
output "private_route_table_ids"     { value = aws_route_table.private[*].id }
output "nat_gateway_ids"             { value = aws_nat_gateway.this[*].id }
output "vpc_endpoint_ids"            { value = { for k, v in aws_vpc_endpoint.interface : k => v.id } }
