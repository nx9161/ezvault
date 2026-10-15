// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/storage/r2.ts — Cloudflare R2 driver (S3-compatible subset only,
 * ADR-2.9). The ONLY module allowed to make Cloudflare-specific calls.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *      R2_BUCKET_DATA (default 'ezvault-data').
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageDriver, HeadInfo, PresignGetOptions } from './driver';

const PUT_TTL_SEC = 15 * 60; // 15-min presigned PUT (phase2 §2.11)
const GET_TTL_SEC = 5 * 60;  // 5-min presigned GET (phase2 §2.2)

export class R2StorageDriver implements StorageDriver {
  readonly name = 'r2' as const;
  private client: S3Client;
  private bucket: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error('R2 env vars missing (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).');
    }
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.bucket = process.env.R2_BUCKET_DATA || 'ezvault-data';
  }

  async presignPut(key: string, contentType: string, ttlSec = PUT_TTL_SEC): Promise<string> {
    // The signed Content-Type comes from the server allowlist — never from
    // client claims beyond the allowlisted value (AppSec §1.1a).
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSec });
  }

  async presignGet(key: string, opts: PresignGetOptions = {}): Promise<string> {
    const ttl = opts.ttlSec ?? GET_TTL_SEC;
    let disposition: string | undefined;
    if (opts.disposition === 'attachment') {
      // B2: originals never render inline; filename is server-controlled.
      disposition = opts.filename
        ? `attachment; filename="${opts.filename.replace(/["\r\n]/g, '')}"`
        : 'attachment';
    } else if (opts.disposition === 'inline') {
      disposition = 'inline';
    }
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      // B2: response headers pinned at mint time — Content-Type comes from
      // the DB-recorded allowlist mimetype, never from object metadata.
      ...(disposition ? { ResponseContentDisposition: disposition } : {}),
      ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttl });
  }

  async head(key: string): Promise<HeadInfo | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType,
        metadata: out.Metadata,
        lastModified: out.LastModified?.toISOString(),
      };
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    if (!out.Body) throw new Error(`R2 getRange: empty body for ${key}`);
    return Buffer.from(await out.Body.transformToByteArray());
  }

  async getBytes(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`R2 getBytes: empty body for ${key}`);
    return Buffer.from(await out.Body.transformToByteArray());
  }

  async putBytes(
    key: string,
    body: Buffer,
    opts: { contentType?: string; metadata?: Record<string, string> } = {},
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        Metadata: opts.metadata,
      }),
    );
  }

  async copy(
    srcKey: string,
    destKey: string,
    opts: { contentType?: string; metadata?: Record<string, string> } = {},
  ): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        CopySource: `${this.bucket}/${encodeURIComponent(srcKey)}`,
        ...(opts.contentType || opts.metadata
          ? {
              MetadataDirective: 'REPLACE',
              ContentType: opts.contentType,
              Metadata: opts.metadata,
            }
          : { MetadataDirective: 'COPY' }),
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (!batch.length) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const outKeys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) if (o.Key) outKeys.push(o.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return outKeys;
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
