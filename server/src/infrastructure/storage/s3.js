const {
    S3Client,
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateBucketCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListPartsCommand,
    PutBucketCorsCommand,
    PutBucketLifecycleConfigurationCommand,
    PutObjectCommand,
    UploadPartCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const config = require("../../config");
const { logger } = require("../logger");

// Object storage over the S3 API: MinIO (local Docker or self-hosted),
// Cloudflare R2, AWS S3, or anything else that speaks S3.
//
// Browsers upload and download directly from storage using short-lived
// signed URLs, so file bytes never pass through this server.

const log = logger.child({ component: "storage" });

const isNotFound = (err) => err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
const isNoSuchUpload = (err) => err?.name === "NoSuchUpload" || err?.Code === "NoSuchUpload" || err?.$metadata?.httpStatusCode === 404;

const createS3Storage = () => {
    const { endpoint, publicEndpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, createBucket } =
        config.storage.s3;

    const clientFor = (url) =>
        new S3Client({
            region,
            endpoint: url || undefined,
            forcePathStyle,
            credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
            // Newer SDKs add CRC32 checksums to every upload by default. A browser
            // uploading to a signed URL can't compute them, and not every
            // S3-compatible service supports them, so only send them when an
            // operation requires one.
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
        });

    // The server talks to storage at `endpoint` (inside Docker: http://minio:9000).
    // Signed URLs must use the address browsers can reach (http://localhost:9000),
    // and a signature covers the host, so links are signed with a second client.
    // Signing is local computation; this client never makes a request.
    const client = clientFor(endpoint);
    const signer = publicEndpoint === endpoint ? client : clientFor(publicEndpoint);

    const publicOrigin = (() => {
        if (publicEndpoint) return new URL(publicEndpoint).origin;
        return forcePathStyle ? `https://s3.${region}.amazonaws.com` : `https://${bucket}.s3.${region}.amazonaws.com`;
    })();

    // Lets browsers on our origins upload directly. AWS and R2 support this
    // call; MinIO answers "not implemented" (it allows all origins by default).
    const configureCors = async () => {
        const origins = [config.appUrl, ...config.corsOrigins].filter(Boolean);
        if (origins.length === 0) return;
        try {
            await client.send(
                new PutBucketCorsCommand({
                    Bucket: bucket,
                    CORSConfiguration: {
                        CORSRules: [
                            {
                                AllowedOrigins: origins,
                                AllowedMethods: ["PUT", "GET", "HEAD"],
                                AllowedHeaders: ["*"],
                                ExposeHeaders: ["ETag"],
                                MaxAgeSeconds: 3600,
                            },
                        ],
                    },
                })
            );
            log.info({ event: "storage.cors_configured", origins }, "Bucket CORS configured");
        } catch (err) {
            log.info(
                { event: "storage.cors_skipped", reason: err.name },
                "Couldn't set bucket CORS; make sure the bucket allows uploads from the app's origin"
            );
        }
    };

    // Multipart uploads that are never completed or aborted keep using space
    // (invisibly: they aren't objects yet). The app aborts the ones it knows
    // were abandoned; this rule catches the rest. Only set on a bucket the app
    // created, since it replaces any existing lifecycle rules. (MinIO also
    // cleans up stale uploads by itself after 24 hours.)
    const configureLifecycle = async () => {
        try {
            await client.send(
                new PutBucketLifecycleConfigurationCommand({
                    Bucket: bucket,
                    LifecycleConfiguration: {
                        Rules: [
                            {
                                ID: "abort-incomplete-uploads",
                                Status: "Enabled",
                                Filter: { Prefix: "shares/" },
                                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
                            },
                        ],
                    },
                })
            );
        } catch (err) {
            log.info({ event: "storage.lifecycle_skipped", reason: err.name }, "Couldn't set the bucket lifecycle rule");
        }
    };

    return {
        driver: "s3",
        publicOrigin,

        async init() {
            try {
                await client.send(new HeadBucketCommand({ Bucket: bucket }));
            } catch (err) {
                if (!isNotFound(err) || !createBucket) {
                    throw new Error(`Storage bucket "${bucket}" isn't reachable: ${err.name || err.message}`, { cause: err });
                }
                await client.send(new CreateBucketCommand({ Bucket: bucket }));
                log.info({ event: "storage.bucket_created", bucket }, "Created storage bucket");
                await configureLifecycle();
            }
            await configureCors();
            log.info({ event: "storage.ready", bucket, endpoint: endpoint || "aws" }, "Object storage ready");
        },

        async health() {
            try {
                await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(2000) });
                return "up";
            } catch {
                return "down";
            }
        },

        // A URL the browser PUTs the file to. Content-Type and Content-Length
        // are part of the signature: storage rejects any other type or size.
        async createUploadTarget({ key, size, contentType }) {
            const url = await getSignedUrl(
                signer,
                new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }),
                { expiresIn: config.uploadWindowSeconds, signableHeaders: new Set(["content-type", "content-length"]) }
            );
            return { method: "PUT", url, headers: { "Content-Type": contentType } };
        },

        // ---- Multipart (resumable) uploads ----
        // The browser uploads each part to its own signed URL. Which parts
        // arrived is asked of storage (ListParts), so the browser never needs
        // to read response headers such as ETag.

        async createMultipartUpload({ key, contentType }) {
            const { UploadId } = await client.send(
                new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
            );
            return UploadId;
        },

        // A URL for one part. Its exact size is part of the signature.
        async signUploadPart({ key, uploadId, partNumber, size }) {
            const url = await getSignedUrl(
                signer,
                new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size }),
                { expiresIn: config.uploads.partUrlSeconds, signableHeaders: new Set(["content-length"]) }
            );
            return { method: "PUT", url, headers: {} };
        },

        // Parts received so far: [{ partNumber, size, etag }], or null if the
        // upload no longer exists (completed or aborted).
        async listUploadedParts({ key, uploadId }) {
            const parts = [];
            let PartNumberMarker;
            try {
                for (;;) {
                    const page = await client.send(
                        new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker })
                    );
                    for (const p of page.Parts ?? []) parts.push({ partNumber: p.PartNumber, size: p.Size, etag: p.ETag });
                    if (!page.IsTruncated) break;
                    PartNumberMarker = page.NextPartNumberMarker;
                }
            } catch (err) {
                if (isNoSuchUpload(err)) return null;
                throw err;
            }
            return parts;
        },

        async completeMultipartUpload({ key, uploadId, parts }) {
            await client.send(
                new CompleteMultipartUploadCommand({
                    Bucket: bucket,
                    Key: key,
                    UploadId: uploadId,
                    MultipartUpload: {
                        Parts: [...parts]
                            .sort((a, b) => a.partNumber - b.partNumber)
                            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
                    },
                })
            );
        },

        async abortMultipartUpload({ key, uploadId }) {
            try {
                await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
            } catch (err) {
                if (!isNoSuchUpload(err)) throw err;
            }
        },

        async stat(key) {
            try {
                const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
                return { size: head.ContentLength };
            } catch (err) {
                if (isNotFound(err)) return null;
                throw err;
            }
        },

        // The whole object as a stream (e.g. for the virus scanner).
        async openStream(key) {
            const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            return object.Body;
        },

        // Stores a small object the server made itself (e.g. a thumbnail).
        async put(key, body, contentType) {
            await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
        },

        async readStart(key, bytes) {
            try {
                const object = await client.send(
                    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` })
                );
                return Buffer.from(await object.Body.transformToByteArray());
            } catch (err) {
                // An empty object has no byte range to read.
                if (err?.name === "InvalidRange" || err?.$metadata?.httpStatusCode === 416) return Buffer.alloc(0);
                throw err;
            }
        },

        // Redirects to a short-lived signed URL. Storage serves the file with the
        // headers we choose (name, type, inline or attachment); range requests
        // work, so videos can seek. Valid for the download window, like our own
        // links, so a long video can keep loading.
        async sendDownload(res, { key, contentType, contentDisposition }) {
            const url = await getSignedUrl(
                signer,
                new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    ResponseContentType: contentType,
                    ResponseContentDisposition: contentDisposition,
                    ResponseCacheControl: "private, no-store",
                }),
                { expiresIn: config.downloadWindowSeconds }
            );
            res.set("Cache-Control", "no-store");
            res.redirect(302, url);
        },

        async delete(keys) {
            for (let i = 0; i < keys.length; i += 1000) {
                const batch = keys.slice(i, i + 1000);
                const result = await client.send(
                    new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
                    })
                );
                const failed = (result.Errors ?? []).filter((e) => e.Code !== "NoSuchKey");
                if (failed.length) {
                    throw new Error(`Couldn't delete ${failed.length} object(s): ${failed[0].Code} ${failed[0].Message}`);
                }
            }
        },

        // Every stored file, for the orphan sweep.
        async *list() {
            let ContinuationToken;
            do {
                const page = await client.send(
                    new ListObjectsV2Command({ Bucket: bucket, Prefix: "shares/", ContinuationToken })
                );
                for (const object of page.Contents ?? []) yield { key: object.Key, modifiedAt: object.LastModified };
                ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
            } while (ContinuationToken);
        },
    };
};

module.exports = { createS3Storage };
