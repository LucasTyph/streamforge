variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "name" {
  type    = string
  default = "streamforge"
}

variable "azs" {
  description = "Explicit AZs: a data source could silently change the subnet layout when AWS adds zones."
  type        = list(string)
  default     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "kubernetes_version" {
  type    = string
  default = "1.35"
}

variable "node_instance_types" {
  description = "Workers are CPU-bound (ffmpeg): compute-optimised Graviton instances."
  type        = list(string)
  default     = ["c7g.large"]
}

variable "node_count" {
  type = object({ min = number, max = number, desired = number })
  # KEDA scales worker pods; Karpenter/Cluster Autoscaler would scale nodes in this range.
  default = { min = 2, max = 6, desired = 2 }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "web_origins" {
  type    = list(string)
  default = ["https://streamforge.example.com"]
}

variable "app_namespace" {
  description = "Kubernetes namespace of the app; IRSA trust is scoped to its service accounts."
  type        = string
  default     = "streamforge"
}
