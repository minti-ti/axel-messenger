const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
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

// Безопасный список расширений. Файлы с любым другим расширением
// сохраняются с расширением .bin (отдаются как octet-stream).
const SAFE_EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/json': '.json'
};

const SAFE_EXT_FALLBACK = new Set([
  '.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg',
  '.mp3','.ogg','.wav','.m4a','.webm','.aac','.mp4','.mov','.avi','.mkv',
  '.pdf','.txt','.zip','.doc','.docx','.xls','.xlsx','.json'
]);


const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.json': 'application/json; charset=utf-8'
};

function detectContentType(filename = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.svg') return 'application/octet-stream';
  return CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

function contentDispositionHeader(filename = '', inline = true) {
  const safeName = encodeURIComponent(path.basename(String(filename || 'file')));
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`;
}

function isDangerousInlineType(filename = '', contentType = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ext === '.svg' || /svg|html|xml/i.test(String(contentType || ''));
}

function safeExtension(originalname, mimetype) {
  // 1. Доверяем mimetype в первую очередь (он провалидирован выше — в multer fileFilter)
  const byMime = SAFE_EXT_BY_MIME[String(mimetype || '').toLowerCase()];
  if (byMime) return byMime;

  // 2. Если mime неизвестен, пробуем расширение из имени, но только если оно в белом списке
  const ext = path.extname(String(originalname || '')).toLowerCase();
  if (SAFE_EXT_FALLBACK.has(ext)) return ext;

  // 3. Иначе — .bin
  return '.bin';
}

function makeKey(folder, originalname = '', mimetype = '') {
  const ext = safeExtension(originalname, mimetype);
  const safeFolder = String(folder || 'misc').replace(/[^a-z0-9_-]/gi, '_');
  return `${safeFolder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

// Для локального хранилища имя файла должно сохранять информацию о папке,
// потому что мы складываем всё в один uploads/ без поддиректорий.
// Это нужно для:
//   - распознавания "это аватарка" в маршруте /uploads/ (без авторизации)
//   - сохранения исторической схемы avatar-XXX.jpg
function makeLocalFilename(folder, originalname = '', mimetype = '') {
  const ext = safeExtension(originalname, mimetype);
  const safeFolder = String(folder || 'misc').replace(/[^a-z0-9_-]/gi, '_');
  return `${safeFolder}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

// Кэш проверки бакета — делаем один раз за процесс, чтобы не дёргать HeadBucket
// на каждую загрузку. Если когда-то отвалится — увидим в логах saveUpload.
let bucketChecked = false;

async function ensureS3Bucket() {
  if (!isS3 || !config.storage.bucket) return;
  if (bucketChecked) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
    bucketChecked = true;
  } catch (error) {
    // На Backblaze B2 (и многих других S3-совместимых сервисах) бакет нельзя
    // создать через S3 API — нужно создать в веб-консоли. Просто предупреждаем.
    console.warn(
      `[storage] Bucket "${config.storage.bucket}" not accessible (${error.name || 'error'}). ` +
      `Create it in your storage provider console. Endpoint: ${config.storage.endpoint || 'default AWS'}`
    );
    // Не выставляем bucketChecked=true, чтобы при следующей попытке снова попробовать
    // (бакет может появиться после рестарта без редеплоя).
  }
}

async function saveUpload(file, { folder = 'misc' } = {}) {
  const key = makeKey(folder, file.originalname, file.mimetype);
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
  const filename = makeLocalFilename(folder, file.originalname, file.mimetype);
  fs.writeFileSync(path.join(config.uploadsDir, filename), file.buffer);
  return {
    key: filename,
    url: `/uploads/${filename}`
  };
}

// Жёсткая защита от path-traversal: только базовое имя, никаких .., только белый список символов.
function sanitizeStorageKey(rawKey) {
  if (!rawKey) throw new Error('Empty key');
  // S3 keys могут содержать "folder/file"; локально берём только последний сегмент.
  const lastSegment = rawKey.includes('/') ? rawKey.split('/').pop() : rawKey;
  if (!lastSegment) throw new Error('Invalid key');
  if (lastSegment.includes('..') || lastSegment.startsWith('.')) {
    throw new Error('Invalid key');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(lastSegment)) {
    throw new Error('Invalid key');
  }
  return lastSegment;
}

async function streamStoredFile(key, res) {
  if (isS3) {
    let object;
    try {
      object = await s3.send(new GetObjectCommand({
        Bucket: config.storage.bucket,
        Key: key
      }));
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        res.status(404).json({ error: 'Файл не найден' });
        return;
      }
      throw error;
    }
    const filename = path.basename(String(key || 'file'));
    const dangerousInline = isDangerousInlineType(filename, object.ContentType);
    const fallbackType = detectContentType(filename);
    const contentType = dangerousInline ? 'application/octet-stream' : (object.ContentType || fallbackType);
    res.setHeader('Content-Type', contentType);
    // Жёстко защищаемся от inline-рендеринга HTML/SVG как XSS.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDispositionHeader(filename, !dangerousInline));
    if (object.Body?.pipe) {
      object.Body.pipe(res);
      return;
    }
    const chunks = [];
    for await (const chunk of object.Body) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
    return;
  }

  const filename = sanitizeStorageKey(key);
  const filePath = path.join(config.uploadsDir, filename);

  // Дополнительная защита: убедимся, что итоговый путь физически внутри uploadsDir.
  const resolved = path.resolve(filePath);
  const baseDir = path.resolve(config.uploadsDir);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    res.status(400).json({ error: 'Некорректный путь' });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }
  const dangerousInline = isDangerousInlineType(filename, detectContentType(filename));
  const contentType = dangerousInline ? 'application/octet-stream' : detectContentType(filename);
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDispositionHeader(filename, !dangerousInline));
  fs.createReadStream(resolved).pipe(res);
}

module.exports = {
  saveUpload,
  streamStoredFile,
  sanitizeStorageKey,
  isS3,
  detectContentType
};
