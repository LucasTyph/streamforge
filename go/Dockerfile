# Shared build for Go services without ffmpeg. Usage: --build-arg CMD=sns-shim|progress
# Multi-arch: the build stage runs natively and cross-compiles (no QEMU for Go).
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24 AS build
ARG CMD TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/${CMD} && mkdir /out/data

# distroless static, nonroot tag pinned by digest (multi-arch index)
FROM gcr.io/distroless/static-debian13@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=build /out/app /app
# writable state dir; a fresh named volume mounted here inherits this ownership
COPY --from=build --chown=65532:65532 /out/data /data
USER nonroot:nonroot
ENTRYPOINT ["/app"]
