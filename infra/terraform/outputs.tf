output "app_url_target" {
  description = "Point your domain's DNS (CNAME/alias) here."
  value       = aws_lb.main.dns_name
}
output "ecr_repository" { value = aws_ecr_repository.app.repository_url }
output "kms_app_key_arn" { value = aws_kms_key.app.arn }
output "db_endpoint" { value = aws_db_instance.main.address }
output "db_owner_secret_arn" {
  description = "RDS-managed secret holding the owner password (claimhive_owner)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
output "app_secret_arns" { value = { for k, s in aws_secretsmanager_secret.app : k => s.arn } }
output "cluster" { value = aws_ecs_cluster.main.name }
output "private_subnets" { value = aws_subnet.private[*].id }
output "task_security_group" { value = aws_security_group.tasks.id }
