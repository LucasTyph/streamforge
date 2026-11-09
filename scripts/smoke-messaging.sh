#!/usr/bin/env bash
# Publishes to each SNS topic (sns-shim) and checks the message lands in every
# subscribed SQS queue (ElasticMQ). Verifies that Terraform subscriptions and the
# ElasticMQ queue config agree. Requires the compose stack + `make tf-local`.
set -euo pipefail
SNS=${AWS_ENDPOINT_URL_SNS:-http://localhost:9911}
SQS=${AWS_ENDPOINT_URL_SQS:-http://localhost:9324}
ACCT=000000000000; P=streamforge

sqs() { curl -fsS -X POST "$SQS/" -H "Content-Type: application/x-amz-json-1.0" -H "X-Amz-Target: AmazonSQS.$1" -d "$2"; }
qurl() { echo "$SQS/$ACCT/$P-$1"; }

declare -A routes=([video-uploaded]="probe" [video-probed]="transcode thumbnail" [job-status]="catalog-status")
fail=0
for topic in "${!routes[@]}"; do
  for q in ${routes[$topic]}; do sqs PurgeQueue "{\"QueueUrl\":\"$(qurl $q)\"}" >/dev/null; done
  body="smoke-$topic-$RANDOM"
  curl -fsS "$SNS/" --data-urlencode "Action=Publish" --data-urlencode "TopicArn=arn:aws:sns:us-east-1:$ACCT:$P-$topic" \
    --data-urlencode "Message=$body" >/dev/null
  for q in ${routes[$topic]}; do
    got=$(sqs ReceiveMessage "{\"QueueUrl\":\"$(qurl $q)\",\"WaitTimeSeconds\":2,\"MaxNumberOfMessages\":10}" |
      jq -r '[.Messages[]?.Body] | join(",")')
    if [[ ",$got," == *",$body,"* ]]; then echo "ok   $topic -> $q"; else echo "FAIL $topic -> $q (got: $got)"; fail=1; fi
    sqs PurgeQueue "{\"QueueUrl\":\"$(qurl $q)\"}" >/dev/null
  done
done
# every main queue must redrive to its DLQ
for q in probe transcode thumbnail catalog-status; do
  rp=$(sqs GetQueueAttributes "{\"QueueUrl\":\"$(qurl $q)\",\"AttributeNames\":[\"RedrivePolicy\"]}" | jq -r '.Attributes.RedrivePolicy // empty')
  if [[ "$rp" == *"$P-$q-dlq"* && "$rp" == *'"maxReceiveCount":3'* ]]; then echo "ok   $q redrive -> $q-dlq"; else echo "FAIL $q redrive: $rp"; fail=1; fi
done
exit $fail
