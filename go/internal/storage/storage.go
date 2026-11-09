// Package storage wraps the S3 calls the workers need.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3 struct{ Client *s3.Client }

// New builds a path-style client (required by SeaweedFS; harmless on AWS).
func New(cfg aws.Config) *S3 {
	return &S3{Client: s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true })}
}

// Download streams bucket/key into path.
func (s *S3) Download(ctx context.Context, bucket, key, path string) error {
	out, err := s.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return fmt.Errorf("get s3://%s/%s: %w", bucket, key, err)
	}
	defer out.Body.Close()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, out.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Exists reports whether bucket/key exists.
func (s *S3) Exists(ctx context.Context, bucket, key string) (bool, error) {
	_, err := s.Client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &bucket, Key: &key})
	var nf *types.NotFound
	if errors.As(err, &nf) {
		return false, nil
	}
	return err == nil, err
}

// PresignGet returns a temporary GET URL (lets ffprobe read the object without a download).
func (s *S3) PresignGet(ctx context.Context, bucket, key string, ttl time.Duration) (string, error) {
	req, err := s3.NewPresignClient(s.Client).PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key},
		s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// Put uploads one file.
func (s *S3) Put(ctx context.Context, bucket, key, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	_, err = s.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &bucket, Key: &key, Body: f, ContentType: aws.String(contentType(path)),
	})
	if err != nil {
		return fmt.Errorf("put s3://%s/%s: %w", bucket, key, err)
	}
	return nil
}

// UploadDir uploads every file under dir to prefix/<relative path>, except files named
// in `last`, which are uploaded afterwards in the given order (the "commit" step).
func (s *S3) UploadDir(ctx context.Context, bucket, prefix, dir string, last ...string) error {
	isLast := map[string]bool{}
	for _, l := range last {
		isLast[l] = true
	}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		rel = filepath.ToSlash(rel)
		if isLast[rel] {
			return nil
		}
		return s.Put(ctx, bucket, prefix+"/"+rel, path)
	})
	if err != nil {
		return err
	}
	for _, l := range last {
		if err := s.Put(ctx, bucket, prefix+"/"+l, filepath.Join(dir, filepath.FromSlash(l))); err != nil {
			return err
		}
	}
	return nil
}

func contentType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".m3u8":
		return "application/vnd.apple.mpegurl"
	case ".ts":
		return "video/mp2t"
	case ".vtt":
		return "text/vtt"
	}
	if t := mime.TypeByExtension(filepath.Ext(path)); t != "" {
		return t
	}
	return "application/octet-stream"
}
