terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  # Keep state in an encrypted, versioned S3 bucket you create first (see docs/DEPLOYMENT.md):
  # backend "s3" {
  #   bucket       = "claimhive-terraform-state-ACCOUNT_ID"
  #   key          = "claimhive/production.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Application = "claimhive", Environment = var.environment, DataClass = "phi" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }
data "aws_partition" "current" {}
