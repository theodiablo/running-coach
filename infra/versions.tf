# Terraform settings, provider constraints, and remote state.
#
# The state bucket is deliberately NOT managed here: it has to exist before
# `terraform init` can run at all. It was created once with the AWS CLI and the
# exact commands are recorded in infra/README.md.

terraform {
  required_version = "~> 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket = "run-app-tfstate"
    key    = "run-app/terraform.tfstate"
    region = "eu-west-1"

    encrypt = true

    # Native S3 locking (Terraform 1.10+). The old DynamoDB lock table is not
    # needed and is not created.
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "running-coach"
      ManagedBy = "terraform"
      Repo      = "theodiablo/running-coach"
    }
  }
}
