# Shared build for Go services without ffmpeg. Usage: --build-arg CMD=sns-shim
# (ffmpeg workers get their own base in M2/M4.)
FROM golang:1.27.3-alpine3.24 AS build
ARG CMD
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/${CMD} && mkdir /out/data

# distroless static, nonroot tag pinned by digest
FROM gcr.io/distroless/static-debian13@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=build /out/app /app
# writable state dir; a fresh named volume mounted here inherits this ownership
COPY --from=build --chown=65532:65532 /out/data /data
USER nonroot:nonroot
ENTRYPOINT ["/app"]
