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
  ingress {
    from_port       = 0
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
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

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
  condition {
    path_pattern { values = ["/v1/*", "/health"] }
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

  # Autoscaling owns desired_count once the scalable target exists.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
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

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
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
      { name = "BACKEND_URL", value = "http://localhost:4000" },
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

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ── Application Auto Scaling: scalable targets ────────────────────────────────
resource "aws_appautoscaling_target" "backend" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.backend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.autoscaling["backend"].min_capacity
  max_capacity       = local.backend_max
}

resource "aws_appautoscaling_target" "frontend" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.frontend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.autoscaling["frontend"].min_capacity
  max_capacity       = local.frontend_max
}

resource "aws_appautoscaling_target" "analytics" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.analytics.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.autoscaling["analytics"].min_capacity
  max_capacity       = local.analytics_max
}

# ── Backend scaling policies (single-writer constrained, #117) ────────────────
# Backend max_capacity is pinned to 1, so these policies exist for observability
# and future use but cannot add concurrent writers to the SQLite database.
resource "aws_appautoscaling_policy" "backend_cpu" {
  name               = "${var.name}-backend-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.backend.service_namespace
  resource_id        = aws_appautoscaling_target.backend.resource_id
  scalable_dimension = aws_appautoscaling_target.backend.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling["backend"].cpu_target_value
    scale_out_cooldown = var.autoscaling["backend"].scale_out_cooldown
    scale_in_cooldown  = var.autoscaling["backend"].scale_in_cooldown
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "backend_memory" {
  name               = "${var.name}-backend-memory"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.backend.service_namespace
  resource_id        = aws_appautoscaling_target.backend.resource_id
  scalable_dimension = aws_appautoscaling_target.backend.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling["backend"].memory_target_value
    scale_out_cooldown = var.autoscaling["backend"].scale_out_cooldown
    scale_in_cooldown  = var.autoscaling["backend"].scale_in_cooldown
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}

# ── Frontend scaling policies ─────────────────────────────────────────────────
resource "aws_appautoscaling_policy" "frontend_cpu" {
  name               = "${var.name}-frontend-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.frontend.service_namespace
  resource_id        = aws_appautoscaling_target.frontend.resource_id
  scalable_dimension = aws_appautoscaling_target.frontend.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling["frontend"].cpu_target_value
    scale_out_cooldown = var.autoscaling["frontend"].scale_out_cooldown
    scale_in_cooldown  = var.autoscaling["frontend"].scale_in_cooldown
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "frontend_memory" {
  name               = "${var.name}-frontend-memory"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.frontend.service_namespace
  resource_id        = aws_appautoscaling_target.frontend.resource_id
  scalable_dimension = aws_appautoscaling_target.frontend.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling["frontend"].memory_target_value
    scale_out_cooldown = var.autoscaling["frontend"].scale_out_cooldown
    scale_in_cooldown  = var.autoscaling["frontend"].scale_in_cooldown
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}

# ── Analytics scaling policies (CPU + queue depth) ────────────────────────────
resource "aws_appautoscaling_policy" "analytics_cpu" {
  name               = "${var.name}-analytics-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.analytics.service_namespace
  resource_id        = aws_appautoscaling_target.analytics.resource_id
  scalable_dimension = aws_appautoscaling_target.analytics.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling["analytics"].cpu_target_value
    scale_out_cooldown = var.autoscaling["analytics"].scale_out_cooldown
    scale_in_cooldown  = var.autoscaling["analytics"].scale_in_cooldown
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "analytics_queue" {
  count              = var.autoscaling["analytics"].queue_metric_name != null ? 1 : 0
  name               = "${var.name}-analytics-queue"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.analytics.service_namespace
  resource_id        = aws_appautoscaling_target.analytics.resource_id
  scalable_dimension = aws_appautoscaling_target.analytics.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling["analytics"].queue_target_value
    scale_out_cooldown = var.autoscaling["analytics"].scale_out_cooldown
    scale_in_cooldown  = var.autoscaling["analytics"].scale_in_cooldown
    customized_metric_specification {
      metric_name = var.autoscaling["analytics"].queue_metric_name
      namespace   = var.autoscaling["analytics"].queue_metric_ns
      statistic   = "Average"
      dimensions = {
        ClusterName = aws_ecs_cluster.this.name
        ServiceName = aws_ecs_service.analytics.name
      }
    }
  }
}

# ── Capacity alarms ───────────────────────────────────────────────────────────
# Fires when a service is pinned at its max capacity (scaling exhausted) or when
# the backend writer is running more than one task (data-safety guard, #117).

resource "aws_cloudwatch_metric_alarm" "backend_writer_guard" {
  alarm_name          = "${var.name}-backend-writer-guard"
  alarm_description   = "Backend writer task count exceeded 1; SQLite/EFS multi-writer risk (#117)."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.backend.name
  }
}

resource "aws_cloudwatch_metric_alarm" "backend_at_max_capacity" {
  alarm_name          = "${var.name}-backend-at-max-capacity"
  alarm_description   = "Backend is at max capacity (single-writer constrained); investigate load."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "frontend_at_max_capacity" {
  alarm_name          = "${var.name}-frontend-at-max-capacity"
  alarm_description   = "Frontend CPU high while at max capacity; scaling exhausted."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.autoscaling["frontend"].cpu_target_value
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.frontend.name
  }
}

resource "aws_cloudwatch_metric_alarm" "analytics_at_max_capacity" {
  alarm_name          = "${var.name}-analytics-at-max-capacity"
  alarm_description   = "Analytics CPU high while at max capacity; scaling exhausted."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.autoscaling["analytics"].cpu_target_value
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.analytics.name
  }
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "autoscaling_limits" {
  value = {
    backend   = { min = var.autoscaling["backend"].min_capacity, max = local.backend_max }
    frontend  = { min = var.autoscaling["frontend"].min_capacity, max = local.frontend_max }
    analytics = { min = var.autoscaling["analytics"].min_capacity, max = local.analytics_max }
  }
}
