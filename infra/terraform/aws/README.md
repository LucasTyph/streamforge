# StreamForge on real AWS (Terraform)

> **Never applied by this project.** It is validated (`terraform validate`), linted
> (tflint + AWS ruleset) and security-scanned (checkov: 420 passed, 0 failed) in CI and
> with `make tf-aws-validate`. The running prototype uses local emulators (ADR-002).

## What it creates
| Area | Resources |
|---|---|
| Network | VPC across 3 explicit AZs, private/public/database subnets, one NAT gateway, VPC flow logs (KMS-encrypted), locked-down default security group |
| Kubernetes | EKS (private API endpoint only, all control-plane logs, secrets encrypted with KMS, IRSA), managed Graviton node group (IMDSv2, hop limit 1) |
| Data | RDS Postgres 18 (Multi-AZ, KMS, force SSL, IAM auth, Performance Insights, enhanced monitoring, master password in Secrets Manager rotated every 30 days, deletion protection) and ElastiCache Valkey (2 nodes, Multi-AZ, TLS, auth token, KMS at rest) |
| Pipeline | The same `../modules/pipeline` as local: raw + processed buckets (SSE-KMS, public access blocked, versioning, lifecycle that aborts abandoned multipart uploads), SNS topics and SQS queues + DLQs (KMS, redrive after 3 receives), SNS→SQS subscriptions and queue policies |
| Access | One customer-managed KMS key (rotation on); an IAM role per service, assumable only by that service's ServiceAccount, scoped to the exact prefixes, topics and queues it uses (`irsa.tf`) |

## What's not here (on purpose)
- **CloudFront** in front of the processed bucket (Origin Access Control plus signed
  cookies for playback). Locally, media is read anonymously instead (ADR-003).
- **S3 server access logs and cross-region replication.** Audit would come from CloudTrail
  S3 data events at account level; processed media can be regenerated from the raw uploads.
- **The state bucket itself** (bootstrap chicken-and-egg). Create it once by hand or in a
  separate root.
- **Node autoscaling** (Karpenter). KEDA scales pods (M6); the node group has min/max sizes.

## How you would apply it (needs an AWS account and a budget)
```bash
aws s3 mb s3://<state-bucket> --region eu-west-1
terraform init -backend-config="bucket=<state-bucket>" -backend-config="key=streamforge/terraform.tfstate"
terraform plan -out plan.tfplan
terraform apply plan.tfplan
```
Then install the Helm charts with `secrets.create=false`, AWS endpoints unset (the SDKs
use real AWS), the IRSA role ARNs from `terraform output irsa_role_arns` as ServiceAccount
annotations, `DATABASE_URL` from the RDS secret, and `REDIS_URL=rediss://...`.

Rough cost at list prices (eu-west-1, on-demand, before any usage): EKS control plane
about $73/month, 2 × c7g.large about $105, NAT gateway about $35 plus data, RDS
db.t4g.medium Multi-AZ about $100, 2 × cache.t4g.micro about $25. Roughly **$340/month**
idle. These are estimates, not measured.
