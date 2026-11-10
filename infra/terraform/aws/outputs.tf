output "cluster_name" {
  value = module.eks.cluster_name
}

output "irsa_role_arns" {
  description = "Annotate each ServiceAccount with eks.amazonaws.com/role-arn."
  value       = { for k, r in aws_iam_role.service : k => r.arn }
}

output "db_endpoint" {
  value = module.db.db_instance_endpoint
}

output "db_master_secret_arn" {
  value = module.db.db_instance_master_user_secret_arn
}

output "cache_endpoint" {
  value = aws_elasticache_replication_group.cache.primary_endpoint_address
}

output "pipeline" {
  value = {
    buckets = module.pipeline.buckets
    topics  = module.pipeline.topic_arns
    queues  = module.pipeline.queue_arns
  }
}
