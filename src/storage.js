const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const config = require('./config');

const isS3 = config.storage.mode === 's3';

let s3 = null;
if (isS3) {
  s3 = new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey
    }
  });
}

function ensureLocalDir() {
  if (!fs.existsSync(config.uploadsDir)) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
  }
}

function makeKey(folder, originalname = '') {
  const ext = path.extname(originalname || '');
  const safeFolder = String(folder || 'misc').replace(/[^a-z0-9_-]/gi, '_');
  return `${safeFolder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

async function ensureS3Bucket() {
  if (!isS3 || !config.storage.bucket) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
  } catch (error) {
    await s3.send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
  }
}

async function saveUpload(file, { folder = 'misc' } = {}) {
  const key = makeKey(folder, file.originalname);
  if (isS3) {
    await ensureS3Bucket();
    await s3.send(new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/octet-stream'
    }));
    return {
      key,
      url: `/files/${encodeURIComponent(key)}`
    };
  }

  ensureLocalDir();
  const filename = key.split('/').pop();
  fs.writeFileSync(path.join(config.uploadsDir, filename), file.buffer);
  return {
    key: filename,
    url: `/uploads/${filename}`
  };
}

async function streamStoredFile(key, res) {
  if (isS3) {
    const object = await s3.send(new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key
    }));
    if (object.ContentType) res.setHeader('Content-Type', object.ContentType);
    if (object.Body?.pipe) {
      object.Body.pipe(res);
      return;
    }
    const chunks = [];
    for await (const chunk of object.Body) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
    return;
  }

  const filename = key.includes('/') ? key.split('/').pop() : key;
  const filePath = path.join(config.uploadsDir, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

module.exports = {
  saveUpload,
  streamStoredFile,
  isS3
};
