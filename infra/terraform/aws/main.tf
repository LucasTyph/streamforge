locals {
  name = "${var.name}-${var.environment}"
  azs  = var.azs
}

# ---- encryption --------------------------------------------------------------
# One customer-managed key for app data: buckets, topics, queues, RDS, ElastiCache,
# EKS secrets and log groups. Services that write on our behalf are allowed explicitly.
data "aws_iam_policy_document" "kms" {
  # checkov:skip=CKV_AWS_109:In a key policy, Resource "*" means "this key"; access is limited by principals and conditions
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "AwsServices"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com", "sqs.amazonaws.com", "s3.amazonaws.com", "logs.${var.region}.amazonaws.com", "delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_kms_key" "app" {
  description             = "${local.name} application data"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "app" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.app.key_id
}

# ---- network -------------------------------------------------------------------
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name             = local.name
  cidr             = var.vpc_cidr
  azs              = local.azs
  private_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets   = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, 48 + i)]
  database_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, 64 + i)]

  enable_nat_gateway = true
  single_nat_gateway = true # cost; one NAT per AZ for production-grade availability

  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_cloudwatch_log_group_kms_key_id        = aws_kms_key.app.arn
  flow_log_cloudwatch_log_group_retention_in_days = 365

  manage_default_security_group  = true
  default_security_group_ingress = []
  default_security_group_egress  = []

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# ---- pipeline: same module as local, hardened for AWS -----------------------------
module "pipeline" {
  source                = "../modules/pipeline"
  prefix                = local.name
  web_origins           = var.web_origins
  manage_queues         = true
  enable_queue_policies = true
  harden_buckets        = true
  kms_key_arn           = aws_kms_key.app.arn
}
