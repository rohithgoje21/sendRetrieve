# syntax=docker/dockerfile:1
# MinIO, built from source.
#
# MinIO stopped publishing free container images in 2025 (Docker Hub's
# minio/minio is gone and quay.io requires a login); the community edition is
# distributed as source. This builds the server binary from a pinned commit,
# so builds are reproducible. The first build takes a few minutes; Docker
# caches it after that.

FROM golang:1.25-alpine AS build
RUN apk add --no-cache git
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
ARG MINIO_VERSION=v0.0.0-20260212201848-7aac2a2c5b7c
RUN go install "github.com/minio/minio@${MINIO_VERSION}"

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/minio /usr/bin/minio
EXPOSE 9000 9001
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
    CMD wget -qO- http://127.0.0.1:9000/minio/health/live > /dev/null || exit 1
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
