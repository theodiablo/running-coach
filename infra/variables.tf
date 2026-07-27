variable "aws_region" {
  description = "Region for run-app resources. Matches the site bucket and SES, both already in eu-west-1."
  type        = string
  default     = "eu-west-1"
}

variable "github_repo" {
  description = "owner/name of the repository whose Actions may assume the OIDC roles."
  type        = string
  default     = "theodiablo/running-coach"
}

variable "github_repo_immutable" {
  description = <<-EOT
    The ID-suffixed OIDC subject prefix: owner@<user-id>/name@<repo-id>.

    GitHub mints this repository's `sub` claim in this format even though the
    OIDC customization API reports `use_default: true`, so a trust condition on
    the plain `repo:owner/name:*` form alone does NOT match and assume-role
    fails. Both forms are allowed; the ID-suffixed one additionally survives a
    repository rename. This was learned the hard way during the July 2026
    vibe-coded-run-app -> running-coach rename.
  EOT
  type        = string
  default     = "theodiablo@8282971/running-coach@1261827846"
}

variable "github_allowed_subjects" {
  description = <<-EOT
    Subject suffixes (everything after `repo:<repo>:`) allowed to assume the
    backup role.

    Restricted to the default branch: scheduled workflow runs always use it, and
    the backup role can delete objects, so a pull-request branch should not be
    able to assume it. Widen to ["*"] temporarily if you need to dispatch the
    workflow from a topic branch.
  EOT
  type        = list(string)
  default     = ["ref:refs/heads/main"]
}

variable "github_deploy_subjects" {
  description = <<-EOT
    Subject suffixes (everything after `repo:<repo>:`) allowed to assume the
    deploy role.

    Production deploys run on the default branch and PR previews run on
    `pull_request` (never `pull_request_target`, so forks get no token), which
    is the whole list. The role can overwrite the live site, so it is not
    trusted from an arbitrary ref. Widen temporarily if you need to dispatch
    deploy.yml or deploy-pr.yml from a topic branch.
  EOT
  type        = list(string)
  default     = ["pull_request", "ref:refs/heads/main"]
}

variable "backup_bucket_name" {
  description = "Private bucket holding the daily database dumps. Must not be the site bucket, which is a public CloudFront origin."
  type        = string
  default     = "run-app-db-backups"
}
