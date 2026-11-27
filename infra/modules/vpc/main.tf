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

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.name}.local"
  description = "Private service discovery namespace for ${var.name}"
  vpc         = aws_vpc.this.id
  tags        = { Name = "${var.name}-sd-namespace" }
}

resource "aws_security_group" "service_discovery" {
  name        = "${var.name}-sd-endpoint"
  description = "Allow internal DNS/service discovery traffic within the VPC"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "DNS TCP from VPC"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [var.cidr]
  }

  ingress {
    description = "DNS UDP from VPC"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [var.cidr]
  }

  egress {
    description = "DNS responses within VPC"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [var.cidr]
  }

  tags = { Name = "${var.name}-sd-endpoint" }
}

output "vpc_id"          { value = aws_vpc.this.id }
output "public_subnets"  { value = aws_subnet.public[*].id }
output "private_subnets" { value = aws_subnet.private[*].id }
output "service_discovery_namespace_id"   { value = aws_service_discovery_private_dns_namespace.this.id }
output "service_discovery_namespace_name" { value = aws_service_discovery_private_dns_namespace.this.name }
output "service_discovery_security_group_id" { value = aws_security_group.service_discovery.id }
