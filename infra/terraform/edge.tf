# Internet-facing load balancer: TLS 1.2+ only, HTTP redirects to HTTPS, WAF in front.
resource "aws_security_group" "alb" {
  name   = "${local.prefix}-alb"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

resource "aws_s3_bucket" "alb_logs" {
  bucket        = "${local.prefix}-alb-logs-${local.account}"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" } # ALB log delivery requires SSE-S3
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 400 }
  }
}
data "aws_elb_service_account" "main" {}
resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AlbWrite", Effect = "Allow", Principal = { AWS = data.aws_elb_service_account.main.arn }, Action = "s3:PutObject", Resource = "${aws_s3_bucket.alb_logs.arn}/*" },
      { Sid = "TlsOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.alb_logs.arn, "${aws_s3_bucket.alb_logs.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    ]
  })
}

resource "aws_lb" "main" {
  name                       = local.prefix
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  idle_timeout               = 120 # large imports
  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    enabled = true
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.prefix}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
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

resource "aws_wafv2_web_acl" "main" {
  name  = local.prefix
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  dynamic "rule" {
    for_each = { AWSManagedRulesCommonRuleSet = 1, AWSManagedRulesKnownBadInputsRuleSet = 2, AWSManagedRulesSQLiRuleSet = 3, AWSManagedRulesAmazonIpReputationList = 4 }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
          # File uploads (aging reports, 835/837, PDFs) are larger than the common rule set's 8 KB body limit.
          dynamic "rule_action_override" {
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY"] : []
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = false # sampled requests could show form data
      }
    }
  }
  rule {
    name     = "RateLimit"
    priority = 10
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 1000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit"
      sampled_requests_enabled   = false
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.prefix
    sampled_requests_enabled   = false
  }
}
resource "aws_wafv2_web_acl_association" "main" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
