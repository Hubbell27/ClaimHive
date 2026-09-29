variable "region" {
  description = "AWS region (use one where every service here is HIPAA eligible)."
  type        = string
  default     = "us-east-1"
}
variable "environment" {
  description = "staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}
variable "name" {
  type    = string
  default = "claimhive"
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "certificate_arn" {
  description = "ACM certificate for the app's domain (issued before apply)."
  type        = string
}
variable "image_tag" {
  description = "Image tag in the ECR repository to run (immutable tags: use the git SHA)."
  type        = string
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "db_allocated_storage" {
  type    = number
  default = 50
}
variable "db_multi_az" {
  type    = bool
  default = true
}
variable "web_count" {
  type    = number
  default = 2
}
variable "worker_count" {
  type    = number
  default = 1
}
variable "nat_per_az" {
  description = "One NAT gateway per AZ (resilient) or one shared (cheaper, for staging)."
  type        = bool
  default     = true
}
variable "alert_email" {
  description = "Where CloudWatch alarms are sent (confirm the SNS subscription email)."
  type        = string
}
variable "billing_issuer_name" {
  type    = string
  default = "ClaimHive Inc."
}
variable "billing_issuer_address" {
  type = string
}
variable "billing_issuer_email" {
  type = string
}
variable "anthropic_baa" {
  description = "Set to \"signed\" only once the Anthropic BAA is in place (enables AI letters for real practices)."
  type        = string
  default     = ""
}
variable "create_cloudtrail" {
  description = "Create a multi-region CloudTrail (skip if the organization already has one)."
  type        = bool
  default     = true
}
variable "enable_ai_letters" {
  description = "Inject ANTHROPIC_API_KEY into the tasks (put a value in its secret first)."
  type        = bool
  default     = false
}
