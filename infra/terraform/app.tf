# ECS on Fargate: the web app behind the load balancer, the background worker,
# and a one-off migration task (run before each deploy; see docs/DEPLOYMENT.md).
resource "aws_ecs_cluster" "main" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_security_group" "tasks" {
  name   = "${local.prefix}-tasks"
  vpc_id = aws_vpc.main.id
  egress {
    description = "HTTPS (AWS endpoints, Anthropic API)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "PostgreSQL"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [for s in aws_subnet.db : s.cidr_block]
  }
}
resource "aws_security_group_rule" "web_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.tasks.id
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["web", "worker", "migrate"])
  name              = "/${local.prefix}/${each.key}"
  retention_in_days = 365 # app logs carry ids and outcomes only, never PHI
  kms_key_id        = aws_kms_key.logs.arn
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull the image, write logs, read the secrets at start-up.
resource "aws_iam_role" "execution" {
  name               = "${local.prefix}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = concat([for s in aws_secretsmanager_secret.app : s.arn], [aws_db_instance.main.master_user_secret[0].secret_arn]) },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.app.arn },
    ]
  })
}

# Task role: what the running app may do. Only the app key, only with ClaimHive's encryption context.
resource "aws_iam_role" "task" {
  name               = "${local.prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "task_kms" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = ["kms:Encrypt", "kms:Decrypt"], Resource = aws_kms_key.app.arn,
      Condition = { StringEquals = { "kms:EncryptionContext:app" = "claimhive" } }
    }]
  })
}

locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
  environment = [
    { name = "APP_ENV", value = var.environment },
    { name = "NODE_ENV", value = "production" },
    { name = "KEY_PROVIDER", value = "kms" },
    { name = "KMS_KEY_ID", value = aws_kms_key.app.arn },
    { name = "AWS_REGION", value = var.region },
    { name = "LOG_LEVEL", value = "info" },
    { name = "BILLING_ISSUER_NAME", value = var.billing_issuer_name },
    { name = "BILLING_ISSUER_ADDRESS", value = var.billing_issuer_address },
    { name = "BILLING_ISSUER_EMAIL", value = var.billing_issuer_email },
    { name = "ANTHROPIC_BAA", value = var.anthropic_baa },
  ]
  runtime_secrets = concat(
    [for k in ["DATABASE_URL", "POOL_DATABASE_URL", "PLATFORM_KEY_WRAPPED"] : { name = k, valueFrom = aws_secretsmanager_secret.app[k].arn }],
    var.enable_ai_letters ? [{ name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.app["ANTHROPIC_API_KEY"].arn }] : [],
  )
  container = {
    for role, cfg in {
      web    = { command = ["npm", "start"], ports = [{ containerPort = 3000, protocol = "tcp" }], secrets = local.runtime_secrets }
      worker = { command = ["npm", "run", "worker"], ports = [], secrets = local.runtime_secrets }
      migrate = { command = ["sh", "-c", "npx prisma migrate deploy && npx tsx scripts/set-role-passwords.ts"], ports = [],
      secrets = [for k in ["MIGRATION_DATABASE_URL", "APP_DB_PASSWORD", "POOL_DB_PASSWORD"] : { name = k, valueFrom = aws_secretsmanager_secret.app[k].arn }] }
      } : role => [{
        name         = role
        image        = local.image
        essential    = true
        command      = cfg.command
        portMappings = cfg.ports
        environment  = local.environment
        secrets      = cfg.secrets
        logConfiguration = {
          logDriver = "awslogs"
          options   = { "awslogs-group" = aws_cloudwatch_log_group.app[role].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = role }
        }
    }]
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.container
  family                   = "${local.prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "web" ? 1024 : 512
  memory                   = each.key == "web" ? 2048 : 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode(each.value)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
}

resource "aws_ecs_service" "web" {
  name                              = "web"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app["web"].arn
  desired_count                     = var.web_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["worker"].arn
  desired_count   = var.worker_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
