# ---- Postgres (RDS) ----------------------------------------------------------------
resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Postgres: only from EKS nodes"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_nodes" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from EKS nodes"
  referenced_security_group_id = module.eks.node_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "7.2.2"

  identifier            = local.name
  engine                = "postgres"
  engine_version        = "18"
  family                = "postgres18"
  major_engine_version  = "18"
  instance_class        = var.db_instance_class
  allocated_storage     = 20
  max_allocated_storage = 100

  db_name                                                = "streamforge"
  username                                               = "streamforge"
  manage_master_user_password                            = true # password in Secrets Manager
  master_user_secret_kms_key_id                          = aws_kms_key.app.arn
  manage_master_user_password_rotation                   = true
  master_user_password_rotation_automatically_after_days = 30

  multi_az               = var.db_multi_az
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.db.id]

  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.app.arn
  iam_database_authentication_enabled = true
  deletion_protection                 = true
  skip_final_snapshot                 = false
  final_snapshot_identifier_prefix    = "${local.name}-final"
  backup_retention_period             = 14
  copy_tags_to_snapshot               = true
  auto_minor_version_upgrade          = true

  performance_insights_enabled           = true
  performance_insights_kms_key_id        = aws_kms_key.app.arn
  monitoring_interval                    = 60
  create_monitoring_role                 = true
  enabled_cloudwatch_logs_exports        = ["postgresql", "upgrade"]
  cloudwatch_log_group_kms_key_id        = aws_kms_key.app.arn
  cloudwatch_log_group_retention_in_days = 365

  parameters = [
    { name = "rds.force_ssl", value = "1" },
    { name = "log_min_duration_statement", value = "500" },
  ]
}

# ---- Redis-compatible cache (ElastiCache Valkey) ------------------------------------
resource "aws_security_group" "cache" {
  name        = "${local.name}-cache"
  description = "Valkey: only from EKS nodes"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_nodes" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Valkey from EKS nodes"
  referenced_security_group_id = module.eks.node_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "cache" {
  name       = "${local.name}-cache"
  subnet_ids = module.vpc.private_subnets
}

resource "random_password" "cache_auth" {
  length  = 48
  special = false
}

resource "aws_cloudwatch_log_group" "cache" {
  name              = "/aws/elasticache/${local.name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id = local.name
  description          = "StreamForge pub/sub (live progress) and throttling"
  engine               = "valkey"
  engine_version       = "8.1"
  node_type            = var.cache_node_type
  num_cache_clusters   = 2
  port                 = 6379

  subnet_group_name          = aws_elasticache_subnet_group.cache.name
  security_group_ids         = [aws_security_group.cache.id]
  automatic_failover_enabled = true
  multi_az_enabled           = true

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.app.arn
  transit_encryption_enabled = true # app connects with rediss://
  auth_token                 = random_password.cache_auth.result
  snapshot_retention_limit   = 3
  auto_minor_version_upgrade = true

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.cache.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }
}
