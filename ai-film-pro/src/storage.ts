import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

// Cloudflare R2 is S3-compatible.
// CONFIRMED REAL GAP, FIXED: the AWS SDK v3's default HTTP handler has no
// bounded request timeout, same class of hang as util.ts's downloadToFile()
// and every fal.subscribe() call site (see those files' own comments) — a
// stalled connection to R2 would hang an upload, and the whole job, forever.
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT, // https://<account_id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
  requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, requestTimeout: 60_000 }),
});
const BUCKET = process.env.R2_BUCKET || "";
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, ""); // public dev URL or custom domain

// .mp3/.wav: CONFIRMED REAL GAP, FIXED — song audio (worker.ts's handleSong)
// and broadcast-spec exports (finishFilm()'s final_broadcast(.5.1).wav) were
// uploaded with no matching entry here, so they fell through to
// application/octet-stream, which can break inline <audio> playback in a
// browser instead of the correct audio/mpeg or audio/wav.
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".zip": "application/zip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

/** Upload a local file to R2 under `key`; returns its public URL. */
export async function uploadFile(localPath: string, key: string): Promise<string> {
  const body = await readFile(localPath);
  const ext = path.extname(localPath).toLowerCase();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentType: TYPES[ext] || "application/octet-stream",
  }));
  return `${PUBLIC_BASE}/${key}`;
}
