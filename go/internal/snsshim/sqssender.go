package snsshim

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// SQSSender delivers to SQS queues, resolving queue ARNs to URLs via GetQueueUrl.
type SQSSender struct {
	Client *sqs.Client
	mu     sync.Mutex
	urls   map[string]string
}

func (s *SQSSender) Send(ctx context.Context, queueArn, body string, attrs map[string]Attr) error {
	url, err := s.url(ctx, queueArn)
	if err != nil {
		return err
	}
	ma := map[string]types.MessageAttributeValue{}
	for k, a := range attrs {
		ma[k] = types.MessageAttributeValue{DataType: aws.String(a.DataType), StringValue: aws.String(a.StringValue)}
	}
	in := &sqs.SendMessageInput{QueueUrl: &url, MessageBody: &body}
	if len(ma) > 0 {
		in.MessageAttributes = ma
	}
	_, err = s.Client.SendMessage(ctx, in)
	return err
}

func (s *SQSSender) url(ctx context.Context, arn string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.urls[arn]; ok {
		return u, nil
	}
	parts := strings.Split(arn, ":") // arn:aws:sqs:region:account:name
	if len(parts) != 6 || parts[2] != "sqs" {
		return "", fmt.Errorf("not an SQS queue ARN: %q", arn)
	}
	out, err := s.Client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: &parts[5], QueueOwnerAWSAccountId: &parts[4]})
	if err != nil {
		return "", err
	}
	if s.urls == nil {
		s.urls = map[string]string{}
	}
	s.urls[arn] = *out.QueueUrl
	return *out.QueueUrl, nil
}
