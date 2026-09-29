# PostgreSQL on RDS: encrypted, TLS-only, Multi-AZ, 35 days of point-in-time recovery.
resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.db[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.prefix}-pg17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  # Never log statement text: queries can carry encrypted PHI parameters.
  parameter {
    name  = "log_statement"
    value = "none"
  }
}

resource "aws_security_group" "db" {
  name   = "${local.prefix}-db"
  vpc_id = aws_vpc.main.id
  ingress {
    description     = "PostgreSQL from app tasks only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

resource "aws_db_instance" "main" {
  identifier                            = local.prefix
  engine                                = "postgres"
  engine_version                        = "17"
  instance_class                        = var.db_instance_class
  allocated_storage                     = var.db_allocated_storage
  max_allocated_storage                 = var.db_allocated_storage * 4
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.data.arn
  db_name                               = "claimhive"
  username                              = "claimhive_owner"
  manage_master_user_password           = true # stored and rotated in Secrets Manager
  master_user_secret_kms_key_id         = aws_kms_key.app.arn
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.main.name
  multi_az                              = var.db_multi_az
  publicly_accessible                   = false
  backup_retention_period               = 35
  backup_window                         = "07:00-08:00"
  maintenance_window                    = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.prefix}-final"
  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  iam_database_authentication_enabled   = false
}

# App secrets. Terraform creates the containers; values are put in once by hand
# (docs/DEPLOYMENT.md), so they never appear in Terraform state.
resource "aws_secretsmanager_secret" "app" {
  for_each   = toset(["DATABASE_URL", "POOL_DATABASE_URL", "MIGRATION_DATABASE_URL", "APP_DB_PASSWORD", "POOL_DB_PASSWORD", "PLATFORM_KEY_WRAPPED", "ANTHROPIC_API_KEY"])
  name       = "${local.prefix}/${each.key}"
  kms_key_id = aws_kms_key.app.arn
}

resource "aws_ecr_repository" "app" {
  name                 = local.prefix
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.app.arn
  }
}
