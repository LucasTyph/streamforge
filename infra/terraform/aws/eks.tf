module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.29.0"

  name               = local.name
  kubernetes_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Private API endpoint only: kubectl/CI reach it from inside the VPC (VPN, SSM or a
  # self-hosted runner), never from the internet.
  endpoint_private_access = true
  endpoint_public_access  = false

  enable_irsa                              = true # OIDC provider for the service-account roles in irsa.tf
  enable_cluster_creator_admin_permissions = true

  create_kms_key = false
  encryption_config = {
    resources        = ["secrets"]
    provider_key_arn = aws_kms_key.app.arn
  }
  enabled_log_types                      = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  cloudwatch_log_group_kms_key_id        = aws_kms_key.app.arn
  cloudwatch_log_group_retention_in_days = 365

  addons = {
    coredns                = {}
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
    eks-pod-identity-agent = { before_compute = true }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_ARM_64_STANDARD" # images are built multi-arch (amd64 + arm64)
      instance_types = var.node_instance_types
      min_size       = var.node_count.min
      max_size       = var.node_count.max
      desired_size   = var.node_count.desired
      metadata_options = {
        http_tokens                 = "required" # IMDSv2 only
        http_put_response_hop_limit = 1          # pods can't reach node credentials
      }
    }
  }
}
