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

# Persistence strategy: "sqlite-efs" (single writer, EFS-backed SQLite) or
# "postgres-rds" (multi-writer, RDS-backed). See docs/persistence-strategy.md.
variable "persistence_backend" {
  type    = string
  default = "sqlite-efs"

  validation {
    condition     = contains(["sqlite-efs", "postgres-rds"], var.persistence_backend)
    error_message = "persistence_backend must be one of: sqlite-efs, postgres-rds."
  }
}

# Number of trusted proxy hops between the client and the backend task.
# The ALB is the only hop in front of the backend, so this defaults to 1.
variable "trust_proxy_hops" {
  type    = number
  default = 1
}

# CIDR ranges of the load balancer / VPC from which forwarded headers are trusted.
variable "trusted_proxy_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
}

# Percentage of backend traffic routed to the canary target group (0-100).
# 0 = all traffic on the stable target group; 100 = fully promoted canary.
variable "backend_canary_weight" {
  type    = number
  default = 0
  validation {
    condition     = var.backend_canary_weight >= 0 && var.backend_canary_weight <= 100
    error_message = "backend_canary_weight must be between 0 and 100."
  }
}

# ── Autoscaling configuration ─────────────────────────────────────────────────
# Per-service scaling is defined via `var.autoscaling` so metrics, min/max
# counts, cooldowns and cost caps are explicit and reviewable per service.
#
# NOTE (#117): the backend writes to a single EFS-backed SQLite database. SQLite
# does not support safe multi-writer access over EFS, so the backend is
# constrained to a single writer task (max_capacity = 1). Scaling the backend
# horizontally requires migrating to a concurrent-safe datastore first. The
# frontend and analytics services are stateless and may scale freely.
variable "autoscaling" {
  description = "Per-service autoscaling configuration (metrics, min/max, cooldowns, cost caps)."
  type = map(object({
    min_capacity       = number
    max_capacity       = number
    scale_out_cooldown = number
    scale_in_cooldown  = number
    # Cost cap: maximum number of tasks allowed by budget for this service.
    cost_cap_max_tasks = number
    # CPU target tracking (percent utilisation).
    cpu_target_value = number
    # Optional memory target tracking (percent utilisation).
    memory_target_value = optional(number)
    # Optional queue-depth (custom metric) target tracking.
    queue_metric_name  = optional(string)
    queue_metric_ns    = optional(string, "Vaccichain/Queues")
    queue_target_value = optional(number)
  }))
  default = {
    backend = {
      min_capacity        = 1
      max_capacity        = 1 # single-writer constraint (#117)
      scale_out_cooldown  = 300
      scale_in_cooldown   = 300
      cost_cap_max_tasks  = 1
      cpu_target_value    = 70
      memory_target_value = 80
    }
    frontend = {
      min_capacity        = 1
      max_capacity        = 6
      scale_out_cooldown  = 60
      scale_in_cooldown   = 300
      cost_cap_max_tasks  = 6
      cpu_target_value    = 65
      memory_target_value = 75
    }
    analytics = {
      min_capacity        = 1
      max_capacity        = 4
      scale_out_cooldown  = 120
      scale_in_cooldown   = 300
      cost_cap_max_tasks  = 4
      cpu_target_value    = 70
      queue_metric_name   = "AnalyticsQueueDepth"
      queue_target_value  = 50
    }
  }
}

variable "alarm_actions" {
  description = "ARNs (e.g. SNS topics) notified when capacity alarms fire."
  type        = list(string)
  default     = []
}

locals {
  # Effective max capacity is the lower of the scaling max and the cost cap.
  backend_max   = min(var.autoscaling["backend"].max_capacity, var.autoscaling["backend"].cost_cap_max_tasks)
  frontend_max  = min(var.autoscaling["frontend"].max_capacity, var.autoscaling["frontend"].cost_cap_max_tasks)
  analytics_max = min(var.autoscaling["analytics"].max_capacity, var.autoscaling["analytics"].cost_cap_max_tasks)
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
    path                = "/ready"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
}

resource "aws_lb_target_group" "frontend" {
  name        = "${var.name}-frontend-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path                = "/ready"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
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

# ── Canary target group for backend (weighted traffic switching) ──────────────
# Deploy the new backend revision to this target group, verify health/smoke
# checks, then shift weights on the listener rule below. Rollback = set the
# canary weight back to 0 and drain the canary target group.
resource "aws_lb_target_group" "backend_canary" {
  name        = "${var.name}-backend-canary-tg"
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

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.backend.arn
        weight = var.backend_canary_weight
      }
      target_group {
        arn    = aws_lb_target_group.backend_canary.arn
        weight = 100 - var.backend_canary_weight
      }
      stickiness {
        enabled  = true
        duration = 3600
      }
    }
  }
  condition {
    path_pattern { values = ["/v1/*", "/health"] }
  }
}

# ── Persistence: EFS for SQLite (single-writer) ───────────────────────────────
resource "aws_efs_file_system" "db" {
  count     = var.persistence_backend == "sqlite-efs" ? 1 : 0
  encrypted = true
  tags      = { Name = "${var.name}-db" }
}

resource "aws_efs_mount_target" "db" {
  count           = var.persistence_backend == "sqlite-efs" ? length(var.private_subnets) : 0
  file_system_id  = aws_efs_file_system.db[0].id
  subnet_id       = var.private_subnets[count.index]
  security_groups = [aws_security_group.tasks.id]
}

# ── Persistence: RDS PostgreSQL (multi-writer) ────────────────────────────────
resource "aws_db_subnet_group" "db" {
  count      = var.persistence_backend == "postgres-rds" ? 1 : 0
  name       = "${var.name}-db-subnets"
  subnet_ids = var.private_subnets
}

resource "aws_security_group" "db" {
  count  = var.persistence_backend == "postgres-rds" ? 1 : 0
  name   = "${var.name}-db-sg"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "db" {
  count                     = var.persistence_backend == "postgres-rds" ? 1 : 0
  identifier                = "${var.name}-db"
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = "db.t4g.medium"
  allocated_storage         = 50
  max_allocated_storage     = 200
  storage_encrypted         = true
  multi_az                  = true
  db_subnet_group_name      = aws_db_subnet_group.db[0].name
  vpc_security_group_ids    = [aws_security_group.db[0].id]
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-db-final"
  username                  = "vaccichain"
  manage_master_user_password = true
}

# ── Backend task definition ───────────────────────────────────────────────────
resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  execution_role_arn       = aws_iam_role.execution.arn

  dynamic "volume" {
    for_each = var.persistence_backend == "sqlite-efs" ? [1] : []
    content {
      name = "db-data"
      efs_volume_configuration {
        file_system_id = aws_efs_file_system.db[0].id
        root_directory = "/"
      }
    }
  }

  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.backend_image
    essential = true
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    mountPoints = var.persistence_backend == "sqlite-efs" ? [{
      sourceVolume  = "db-data"
      containerPath = "/data"
      readOnly      = false
    }] : []
    secrets = [for k, arn in var.secret_arns : { name = k, valueFrom = arn }]
    environment = concat(
      [
        { name = "NODE_ENV", value = "production" },
        { name = "PERSISTENCE_BACKEND", value = var.persistence_backend },
        # Trust-proxy settings must match the ALB topology (single ALB hop).
        { name = "TRUST_PROXY_HOPS", value = tostring(var.trust_proxy_hops) },
        { name = "TRUSTED_PROXY_CIDRS", value = join(",", var.trusted_proxy_cidrs) },
      ],
      var.persistence_backend == "sqlite-efs" ? [
        { name = "DATABASE_PATH", value = "/data/vaccichain.db" },
      ] : [
        { name = "DATABASE_URL", value = "postgres://${aws_db_instance.db[0].username}@${aws_db_instance.db[0].endpoint}/${aws_db_instance.db[0].db_name}" },
      ],
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.backend.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "backend"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:4000/ready || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "backend" {
  name            = "${var.name}-backend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.backend.arn
  # SQLite over EFS supports only a single writer; scale out only with RDS.
  desired_count = var.persistence_backend == "sqlite-efs" ? 1 : var.desired_count
  launch_type   = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

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
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:80/ready || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "frontend" {
  name            = "${var.name}-frontend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

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
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:8001/ready || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "analytics" {
  name            = "${var.name}-python-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.analytics.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets         = var.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }

  depends_on = [aws_service_discovery_service.backend]
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "backend_target_group_arn"        { value = aws_lb_target_group.backend.arn }
output "backend_canary_target_group_arn" { value = aws_lb_target_group.backend_canary.arn }
output "persistence_backend" { value = var.persistence_backend }
output "database_endpoint" {
  value = var.persistence_backend == "postgres-rds" ? aws_db_instance.db[0].endpoint : null
}
