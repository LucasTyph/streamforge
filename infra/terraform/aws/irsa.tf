# IAM Roles for Service Accounts: each pod's ServiceAccount assumes exactly one role, and
# each role gets only the S3 objects, topics and queues that service touches.
locals {
  b = module.pipeline.bucket_arns
  t = module.pipeline.topic_arns
  q = module.pipeline.queue_arns
  d = module.pipeline.dlq_arns

  consume = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]

  service_policies = {
    catalog-api = [
      { actions = ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], resources = ["${local.b.raw}/uploads/*"] },
      { actions = ["s3:ListBucket"], resources = [local.b.raw] },
      { actions = ["sns:Publish"], resources = [local.t["video-uploaded"]] },
      { actions = local.consume, resources = [local.q["catalog-status"]] },
      # Ops page: queue depths, DLQ peek and redrive
      { actions = ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"], resources = values(local.q) },
      { actions = local.consume, resources = values(local.d) },
    ]
    probe-worker = [
      { actions = local.consume, resources = [local.q.probe] },
      { actions = ["s3:GetObject"], resources = ["${local.b.raw}/uploads/*"] },
      { actions = ["sns:Publish"], resources = [local.t["video-probed"], local.t["job-status"]] },
    ]
    transcode-worker = [
      { actions = local.consume, resources = [local.q.transcode] },
      { actions = ["s3:GetObject"], resources = ["${local.b.raw}/uploads/*"] },
      { actions = ["s3:PutObject", "s3:GetObject"], resources = ["${local.b.processed}/*"] },
      { actions = ["sns:Publish"], resources = [local.t["job-status"]] },
    ]
    thumbnail-worker = [
      { actions = local.consume, resources = [local.q.thumbnail] },
      { actions = ["s3:GetObject"], resources = ["${local.b.raw}/uploads/*"] },
      { actions = ["s3:PutObject", "s3:GetObject"], resources = ["${local.b.processed}/*"] },
      { actions = ["sns:Publish"], resources = [local.t["job-status"]] },
    ]
  }
}

data "aws_iam_policy_document" "assume" {
  for_each = local.service_policies
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:${var.app_namespace}:${each.key}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "service" {
  for_each = local.service_policies
  dynamic "statement" {
    for_each = each.value
    content {
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
  statement {
    sid       = "UseAppKey" # encrypted buckets, topics and queues
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }
}

resource "aws_iam_role" "service" {
  for_each           = local.service_policies
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.assume[each.key].json
}

resource "aws_iam_role_policy" "service" {
  for_each = local.service_policies
  name     = "access"
  role     = aws_iam_role.service[each.key].id
  policy   = data.aws_iam_policy_document.service[each.key].json
}
