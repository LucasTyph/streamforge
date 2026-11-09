// Package snsshim is a minimal SNS emulator (AWS query protocol) that fans out
// published messages to SQS queues (ElasticMQ). It implements only the subset
// StreamForge and the Terraform AWS provider use. See docs/adr/002-aws-emulation.md.
package snsshim

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const xmlns = "http://sns.amazonaws.com/doc/2010-03-31/"

// Attr is a message attribute forwarded to SQS.
type Attr struct{ DataType, StringValue string }

// Sender delivers a message to an SQS queue identified by its ARN.
type Sender interface {
	Send(ctx context.Context, queueArn, body string, attrs map[string]Attr) error
}

type Topic struct {
	Arn        string            `json:"arn"`
	Attributes map[string]string `json:"attributes"`
	Tags       map[string]string `json:"tags"`
}

type Sub struct {
	Arn        string            `json:"arn"`
	TopicArn   string            `json:"topicArn"`
	Protocol   string            `json:"protocol"`
	Endpoint   string            `json:"endpoint"`
	Attributes map[string]string `json:"attributes"`
}

type state struct {
	Topics map[string]*Topic `json:"topics"`
	Subs   map[string]*Sub   `json:"subs"`
}

// Server is the HTTP handler. Create it with New.
type Server struct {
	mu      sync.Mutex
	st      state
	path    string // persistence file ("" = memory only)
	region  string
	account string
	sender  Sender
	log     *slog.Logger
}

func New(path, region, account string, sender Sender, log *slog.Logger) (*Server, error) {
	s := &Server{path: path, region: region, account: account, sender: sender, log: log,
		st: state{Topics: map[string]*Topic{}, Subs: map[string]*Sub{}}}
	if path != "" {
		if b, err := os.ReadFile(path); err == nil {
			if err := json.Unmarshal(b, &s.st); err != nil {
				return nil, fmt.Errorf("load state: %w", err)
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	return s, nil
}

type apiErr struct {
	status    int
	code, msg string
}

func (e *apiErr) Error() string { return e.code + ": " + e.msg }

func notFound(msg string) *apiErr { return &apiErr{404, "NotFound", msg} }
func invalid(msg string) *apiErr  { return &apiErr{400, "InvalidParameter", msg} }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz", "/readyz":
		w.Write([]byte("ok"))
		return
	}
	if err := r.ParseForm(); err != nil {
		s.writeErr(w, invalid(err.Error()))
		return
	}
	action := r.Form.Get("Action")
	inner, err := s.dispatch(r.Context(), action, r.Form)
	if err != nil {
		ae, ok := err.(*apiErr)
		if !ok {
			ae = &apiErr{500, "InternalError", err.Error()}
		}
		s.log.Warn("sns error", "action", action, "err", ae)
		s.writeErr(w, ae)
		return
	}
	w.Header().Set("Content-Type", "text/xml")
	fmt.Fprintf(w, `<%sResponse xmlns="%s"><%sResult>%s</%sResult><ResponseMetadata><RequestId>%s</RequestId></ResponseMetadata></%sResponse>`,
		action, xmlns, action, inner, action, newID(), action)
}

func (s *Server) writeErr(w http.ResponseWriter, e *apiErr) {
	w.Header().Set("Content-Type", "text/xml")
	w.WriteHeader(e.status)
	fmt.Fprintf(w, `<ErrorResponse xmlns="%s"><Error><Type>Sender</Type><Code>%s</Code><Message>%s</Message></Error><RequestId>%s</RequestId></ErrorResponse>`,
		xmlns, e.code, esc(e.msg), newID())
}

type form = map[string][]string

func get(f form, k string) string {
	if v := f[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// entries parses "<prefix>.N.<k>" / "<prefix>.N.<v>" pairs (N from 1).
func entries(f form, prefix, k, v string) map[string]string {
	out := map[string]string{}
	for i := 1; ; i++ {
		p := prefix + "." + strconv.Itoa(i) + "."
		key, ok := f[p+k]
		if !ok {
			return out
		}
		out[key[0]] = get(f, p+v)
	}
}

func (s *Server) dispatch(ctx context.Context, action string, f form) (string, error) {
	switch action {
	case "CreateTopic", "GetTopicAttributes", "SetTopicAttributes", "DeleteTopic", "ListTopics",
		"Subscribe", "Unsubscribe", "GetSubscriptionAttributes", "SetSubscriptionAttributes",
		"ListSubscriptions", "ListSubscriptionsByTopic", "ListTagsForResource", "TagResource", "UntagResource":
		s.mu.Lock()
		defer s.mu.Unlock()
		out, mutated, err := s.manage(action, f)
		if err == nil && mutated {
			err = s.save()
		}
		return out, err
	case "Publish":
		return s.publish(ctx, f)
	}
	return "", invalid("unsupported action: " + action)
}

func (s *Server) topicArn(name string) string {
	return fmt.Sprintf("arn:aws:sns:%s:%s:%s", s.region, s.account, name)
}

func (s *Server) topic(f form) (*Topic, error) {
	arn := get(f, "TopicArn")
	if arn == "" {
		arn = get(f, "ResourceArn")
	}
	t := s.st.Topics[arn]
	if t == nil {
		return nil, notFound("topic does not exist: " + arn)
	}
	return t, nil
}

// manage handles all control-plane actions. Caller holds s.mu.
func (s *Server) manage(action string, f form) (out string, mutated bool, err error) {
	switch action {
	case "CreateTopic":
		name := get(f, "Name")
		if name == "" {
			return "", false, invalid("Name is required")
		}
		arn := s.topicArn(name)
		t := s.st.Topics[arn]
		if t == nil {
			t = &Topic{Arn: arn, Attributes: map[string]string{}, Tags: map[string]string{}}
			s.st.Topics[arn] = t
		}
		for k, v := range entries(f, "Attributes.entry", "key", "value") {
			t.Attributes[k] = v
		}
		for k, v := range entries(f, "Tags.member", "Key", "Value") {
			t.Tags[k] = v
		}
		return tag("TopicArn", arn), true, nil

	case "GetTopicAttributes":
		t, err := s.topic(f)
		if err != nil {
			return "", false, err
		}
		attrs := map[string]string{
			"TopicArn": t.Arn, "Owner": s.account, "DisplayName": "",
			"Policy":                 defaultPolicy(t.Arn, s.account),
			"SubscriptionsConfirmed": strconv.Itoa(s.subCount(t.Arn)),
			"SubscriptionsPending":   "0", "SubscriptionsDeleted": "0",
			"EffectiveDeliveryPolicy": `{"http":{"defaultHealthyRetryPolicy":{"minDelayTarget":20,"maxDelayTarget":20,"numRetries":3,"numMaxDelayRetries":0,"numNoDelayRetries":0,"numMinDelayRetries":0,"backoffFunction":"linear"},"disableSubscriptionOverrides":false}}`,
		}
		for k, v := range t.Attributes {
			attrs[k] = v
		}
		return attrXML(attrs), false, nil

	case "SetTopicAttributes":
		t, err := s.topic(f)
		if err != nil {
			return "", false, err
		}
		t.Attributes[get(f, "AttributeName")] = get(f, "AttributeValue")
		return "", true, nil

	case "DeleteTopic":
		arn := get(f, "TopicArn")
		delete(s.st.Topics, arn)
		for k, sub := range s.st.Subs {
			if sub.TopicArn == arn {
				delete(s.st.Subs, k)
			}
		}
		return "", true, nil

	case "ListTopics":
		var b strings.Builder
		for _, arn := range sortedKeys(s.st.Topics) {
			b.WriteString("<member>" + tag("TopicArn", arn) + "</member>")
		}
		return "<Topics>" + b.String() + "</Topics>", false, nil

	case "Subscribe":
		t, err := s.topic(f)
		if err != nil {
			return "", false, err
		}
		proto, ep := get(f, "Protocol"), get(f, "Endpoint")
		if proto != "sqs" {
			return "", false, invalid("only the sqs protocol is supported")
		}
		for _, sub := range s.st.Subs { // idempotent, like AWS
			if sub.TopicArn == t.Arn && sub.Protocol == proto && sub.Endpoint == ep {
				return tag("SubscriptionArn", sub.Arn), false, nil
			}
		}
		sub := &Sub{Arn: t.Arn + ":" + newID(), TopicArn: t.Arn, Protocol: proto, Endpoint: ep,
			Attributes: entries(f, "Attributes.entry", "key", "value")}
		s.st.Subs[sub.Arn] = sub
		return tag("SubscriptionArn", sub.Arn), true, nil

	case "Unsubscribe":
		delete(s.st.Subs, get(f, "SubscriptionArn"))
		return "", true, nil

	case "GetSubscriptionAttributes", "SetSubscriptionAttributes":
		sub := s.st.Subs[get(f, "SubscriptionArn")]
		if sub == nil {
			return "", false, notFound("subscription does not exist")
		}
		if action == "SetSubscriptionAttributes" {
			sub.Attributes[get(f, "AttributeName")] = get(f, "AttributeValue")
			return "", true, nil
		}
		attrs := map[string]string{
			"SubscriptionArn": sub.Arn, "TopicArn": sub.TopicArn, "Protocol": sub.Protocol,
			"Endpoint": sub.Endpoint, "Owner": s.account, "PendingConfirmation": "false",
			"ConfirmationWasAuthenticated": "true", "RawMessageDelivery": "false",
			"SubscriptionPrincipal": "arn:aws:iam::" + s.account + ":root",
		}
		for k, v := range sub.Attributes {
			attrs[k] = v
		}
		return attrXML(attrs), false, nil

	case "ListSubscriptions", "ListSubscriptionsByTopic":
		var b strings.Builder
		for _, k := range sortedKeys(s.st.Subs) {
			sub := s.st.Subs[k]
			if action == "ListSubscriptionsByTopic" && sub.TopicArn != get(f, "TopicArn") {
				continue
			}
			b.WriteString("<member>" + tag("SubscriptionArn", sub.Arn) + tag("Owner", s.account) +
				tag("Protocol", sub.Protocol) + tag("Endpoint", sub.Endpoint) + tag("TopicArn", sub.TopicArn) + "</member>")
		}
		return "<Subscriptions>" + b.String() + "</Subscriptions>", false, nil

	case "ListTagsForResource":
		t, err := s.topic(f)
		if err != nil {
			return "", false, err
		}
		var b strings.Builder
		for _, k := range sortedKeys(t.Tags) {
			b.WriteString("<member>" + tag("Key", k) + tag("Value", t.Tags[k]) + "</member>")
		}
		return "<Tags>" + b.String() + "</Tags>", false, nil

	case "TagResource", "UntagResource":
		t, err := s.topic(f)
		if err != nil {
			return "", false, err
		}
		if action == "TagResource" {
			for k, v := range entries(f, "Tags.member", "Key", "Value") {
				t.Tags[k] = v
			}
		} else {
			for i := 1; ; i++ {
				k, ok := f["TagKeys.member."+strconv.Itoa(i)]
				if !ok {
					break
				}
				delete(t.Tags, k[0])
			}
		}
		return "", true, nil
	}
	return "", false, invalid("unsupported action: " + action)
}

func (s *Server) publish(ctx context.Context, f form) (string, error) {
	arn := get(f, "TopicArn")
	if arn == "" {
		arn = get(f, "TargetArn")
	}
	msg := get(f, "Message")
	attrs := map[string]Attr{}
	for i := 1; ; i++ {
		p := "MessageAttributes.entry." + strconv.Itoa(i) + "."
		name, ok := f[p+"Name"]
		if !ok {
			break
		}
		attrs[name[0]] = Attr{DataType: get(f, p+"Value.DataType"), StringValue: get(f, p+"Value.StringValue")}
	}

	s.mu.Lock()
	if s.st.Topics[arn] == nil {
		s.mu.Unlock()
		return "", notFound("topic does not exist: " + arn)
	}
	var subs []Sub
	for _, sub := range s.st.Subs {
		if sub.TopicArn == arn {
			subs = append(subs, *sub)
		}
	}
	s.mu.Unlock()

	id := newUUID()
	for _, sub := range subs {
		body := msg
		if sub.Attributes["RawMessageDelivery"] != "true" {
			body = envelope(id, arn, get(f, "Subject"), msg, attrs)
		}
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := s.sender.Send(ctx, sub.Endpoint, body, attrs)
		cancel()
		if err != nil {
			// AWS retries delivery internally; we surface the failure to the publisher instead.
			return "", &apiErr{500, "InternalError", "deliver to " + sub.Endpoint + ": " + err.Error()}
		}
	}
	s.log.Info("published", "topic", arn, "messageId", id, "subscribers", len(subs))
	return tag("MessageId", id), nil
}

func envelope(id, topicArn, subject, msg string, attrs map[string]Attr) string {
	type mattr struct{ Type, Value string }
	ma := map[string]mattr{}
	for k, a := range attrs {
		ma[k] = mattr{a.DataType, a.StringValue}
	}
	b, _ := json.Marshal(map[string]any{
		"Type": "Notification", "MessageId": id, "TopicArn": topicArn, "Subject": subject,
		"Message": msg, "Timestamp": time.Now().UTC().Format(time.RFC3339Nano), "MessageAttributes": ma,
	})
	return string(b)
}

func (s *Server) subCount(topicArn string) int {
	n := 0
	for _, sub := range s.st.Subs {
		if sub.TopicArn == topicArn {
			n++
		}
	}
	return n
}

func (s *Server) save() error {
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func defaultPolicy(arn, account string) string {
	return fmt.Sprintf(`{"Version":"2008-10-17","Id":"__default_policy_ID","Statement":[{"Sid":"__default_statement_ID","Effect":"Allow","Principal":{"AWS":"*"},"Action":["SNS:Publish","SNS:Subscribe","SNS:GetTopicAttributes"],"Resource":"%s","Condition":{"StringEquals":{"AWS:SourceOwner":"%s"}}}]}`, arn, account)
}

func attrXML(m map[string]string) string {
	var b strings.Builder
	for _, k := range sortedKeys(m) {
		b.WriteString("<entry>" + tag("key", k) + tag("value", m[k]) + "</entry>")
	}
	return "<Attributes>" + b.String() + "</Attributes>"
}

func tag(name, v string) string { return "<" + name + ">" + esc(v) + "</" + name + ">" }

func esc(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
