variable "name"            { type = string }
variable "vpc_id"          { type = string }
variable "public_subnets"  { type = list(string) }
variable "private_subnets" { type = list(string) }
variable "backend_image"   { type = string }
variable "frontend_image"  { type = string }
variable "analytics_image" { type = string }
variable "secret_arns"     { type = map(string) }
variable "backend_cpu"     { type = number; default = 512 }
variable "backend_memory"  { type = number; default = 1024 }
variable "desired_count"   { type = number; default = 1 }
variable "certificate_arn" { type = string }
variable "service_discovery_namespace" {
  type    = string
  default = "internal"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# ── ECS Cluster ───────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ── IAM: task execution role ──────────────────────────────────────────────────
resource "aws_iam_role" "execution" {
  name = "${var.name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "secrets_read" {
  name = "${var.name}-secrets-read"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(var.secret_arns)
    }]
  })
}

# ── CloudWatch log groups (one per service) ───────────────────────────────────
resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${var.name}/backend"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/${var.name}/frontend"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "python_service" {
  name              = "/ecs/${var.name}/python-service"
  retention_in_days = 30
}

# ── Security groups ───────────────────────────────────────────────────────────
resource "aws_security_group" "alb" {
  name   = "${var.name}-alb-sg"
  vpc_id = var.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "tasks" {
  name   = "${var.name}-tasks-sg"
  vpc_id = var.vpc_id

  # Least-privilege ingress: only the backend listener port is reachable from
  # the ALB. Health checks hit the same container port (/health), so no
  # separate ephemeral range is required.
  ingress {
    description     = "Backend listener + health checks from ALB"
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Task-to-task traffic (analytics -> backend) stays inside the tasks SG.
  ingress {
    description = "Analytics to backend via private service discovery"
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    self        = true
  }

  # Egress is intentionally broad: tasks pull images from ECR, write logs to
  # CloudWatch, read Secrets Manager and reach EFS mount targets whose IPs are
  # not statically known. Restricting this would require VPC endpoints for each
  # service; documented here as an accepted, intentional rule.
  egress {
    description = "Outbound to AWS APIs and EFS (intentionally broad)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ── ALB ───────────────────────────────────────────────────────────────────────
resource "aws_lb" "this" {
  name               = "${var.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnets
}

resource "aws_lb_target_group" "backend" {
  name        = "${var.name}-backend-tg"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}

resource "aws_lb_target_group" "frontend" {
  name        = "${var.name}-frontend-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path              = "/"
    healthy_threshold = 2
    interval          = 30
  }
}

# HTTPS listener terminates public traffic with a managed certificate and a
# modern TLS policy (TLS 1.2+ with strong ciphers).
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
  condition {
    path_pattern { values = ["/v1/*", "/health"] }
  }
}

# Plaintext HTTP is an explicit redirect to HTTPS; no application traffic is
# served over port 80.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ── Private service discovery (AWS Cloud Map) ─────────────────────────────────
resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = var.service_discovery_namespace
  description = "Private DNS namespace for ${var.name} services"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "backend" {
  name = "backend"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

# ── EFS for SQLite persistence ────────────────────────────────────────────────
resource "aws_efs_file_system" "db" {
  encrypted = true
  tags      = { Name = "${var.name}-db" }
}

resource "aws_efs_mount_target" "db" {
  count           = length(var.private_subnets)
  file_system_id  = aws_efs_file_system.db.id
  subnet_id       = var.private_subnets[count.index]
  security_groups = [aws_security_group.tasks.id]
}

# ── Backend task definition ───────────────────────────────────────────────────
resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  execution_role_arn       = aws_iam_role.execution.arn

  volume {
    name = "db-data"
    efs_volume_configuration {
      file_system_id = aws_efs_file_system.db.id
      root_directory = "/"
    }
  }

  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.backend_image
    essential = true
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    mountPoints = [{
      sourceVolume  = "db-data"
      containerPath = "/data"
      readOnly      = false
    }]
    secrets = [for k, arn in var.secret_arns : { name = k, valueFrom = arn }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DATABASE_PATH", value = "/data/vaccichain.db" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.backend.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "backend"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:4000/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 15
    }
  }])
}

resource "aws_ecs_service" "backend" {
  name            = "${var.name}-backend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 4000
  }

  service_registries {
    registry_arn = aws_service_discovery_service.backend.arn
  }

  depends_on = [aws_lb_listener.https]
}

# ── Frontend task definition ──────────────────────────────────────────────────
resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "frontend"
    image     = var.frontend_image
    essential = true
    portMappings = [{ containerPort = 80, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.frontend.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "frontend"
      }
    }
  }])
}

resource "aws_ecs_service" "frontend" {
  name            = "${var.name}-frontend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 80
  }

  depends_on = [aws_lb_listener.https]
}

# ── Analytics (python-service) task definition ────────────────────────────────
resource "aws_ecs_task_definition" "analytics" {
  family                   = "${var.name}-python-service"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "python-service"
    image     = var.analytics_image
    essential = true
    portMappings = [{ containerPort = 8001, protocol = "tcp" }]
    environment = [
      { name = "BACKEND_URL", value = "http://backend.${var.service_discovery_namespace}:4000" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.python_service.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "python-service"
      }
    }
  }])
}

resource "aws_ecs_service" "analytics" {
  name            = "${var.name}-python-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.analytics.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }

  depends_on = [aws_service_discovery_service.backend]
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "backend_service_discovery_dns" {
  value = "backend.${var.service_discovery_namespace}"
}
