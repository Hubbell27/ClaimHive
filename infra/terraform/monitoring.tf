resource "aws_sns_topic" "alerts" {
  name              = "${local.prefix}-alerts"
  kms_master_key_id = aws_kms_key.logs.arn
}
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarms = {
    web_5xx     = { ns = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 10, op = "GreaterThanThreshold", dims = { LoadBalancer = aws_lb.main.arn_suffix } }
    unhealthy   = { ns = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0, op = "GreaterThanThreshold", dims = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix } }
    db_cpu      = { ns = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold", dims = { DBInstanceIdentifier = aws_db_instance.main.identifier } }
    db_storage  = { ns = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = 5368709120, op = "LessThanThreshold", dims = { DBInstanceIdentifier = aws_db_instance.main.identifier } }
    worker_down = { ns = "ECS/ContainerInsights", metric = "RunningTaskCount", stat = "Minimum", threshold = 1, op = "LessThanThreshold", dims = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.worker.name } }
  }
}
resource "aws_cloudwatch_metric_alarm" "main" {
  for_each            = local.alarms
  alarm_name          = "${local.prefix}-${each.key}"
  namespace           = each.value.ns
  metric_name         = each.value.metric
  statistic           = each.value.stat
  dimensions          = each.value.dims
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = each.key == "worker_down" ? "breaching" : "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Every KMS unwrap of a practice key, every IAM change and console login is recorded here.
resource "aws_s3_bucket" "trail" {
  count  = var.create_cloudtrail ? 1 : 0
  bucket = "${local.prefix}-cloudtrail-${local.account}"
}
resource "aws_s3_bucket_public_access_block" "trail" {
  count                   = var.create_cloudtrail ? 1 : 0
  bucket                  = aws_s3_bucket.trail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "trail" {
  count  = var.create_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.trail[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_policy" "trail" {
  count  = var.create_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.trail[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AclCheck", Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "s3:GetBucketAcl", Resource = aws_s3_bucket.trail[0].arn },
      { Sid = "Write", Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "s3:PutObject", Resource = "${aws_s3_bucket.trail[0].arn}/AWSLogs/${local.account}/*",
      Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" } } },
      { Sid = "TlsOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.trail[0].arn, "${aws_s3_bucket.trail[0].arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    ]
  })
}
resource "aws_cloudtrail" "main" {
  count                         = var.create_cloudtrail ? 1 : 0
  name                          = local.prefix
  s3_bucket_name                = aws_s3_bucket.trail[0].id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.logs.arn
  depends_on                    = [aws_s3_bucket_policy.trail]
}
