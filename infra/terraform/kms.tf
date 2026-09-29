# Three customer-managed keys, rotated yearly:
#   app  - wraps each practice's data key (KEY_PROVIDER=kms) and the platform key; encrypts app secrets
#   data - RDS storage, snapshots and Performance Insights
#   logs - CloudWatch Logs, SNS, CloudTrail
locals { account = data.aws_caller_identity.current.account_id }

resource "aws_kms_key" "app" {
  description             = "${local.prefix} application key (practice data keys)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}
resource "aws_kms_alias" "app" {
  name          = "alias/${local.prefix}-app"
  target_key_id = aws_kms_key.app.key_id
}

resource "aws_kms_key" "data" {
  description             = "${local.prefix} database key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}
resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "logs" {
  description             = "${local.prefix} logs key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Account", Effect = "Allow", Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${local.account}:root" }, Action = "kms:*", Resource = "*" },
      { Sid    = "CloudWatchLogs", Effect = "Allow", Principal = { Service = "logs.${var.region}.amazonaws.com" },
        Action = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*",
      Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:${data.aws_partition.current.partition}:logs:${var.region}:${local.account}:log-group:*" } } },
      { Sid = "CloudTrailAndSns", Effect = "Allow", Principal = { Service = ["cloudtrail.amazonaws.com", "cloudwatch.amazonaws.com", "sns.amazonaws.com"] },
      Action = ["kms:GenerateDataKey*", "kms:Decrypt", "kms:DescribeKey"], Resource = "*" },
    ]
  })
}
resource "aws_kms_alias" "logs" {
  name          = "alias/${local.prefix}-logs"
  target_key_id = aws_kms_key.logs.key_id
}
