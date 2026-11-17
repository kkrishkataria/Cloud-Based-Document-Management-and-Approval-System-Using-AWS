import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.APP_MODE || 'local';
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
const localDbPath = path.join(dataDir, 'local-db.json');
const app = express();
const upload = multer({ dest: uploadsDir, limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const aws = mode === 'aws' ? {
  db: new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } }),
  s3: new S3Client({ region: process.env.AWS_REGION }),
  ses: new SESClient({ region: process.env.AWS_REGION })
} : null;
if (mode === 'aws' && (!process.env.DATABASE_URL || !process.env.S3_BUCKET || !process.env.SES_FROM_EMAIL)) {
  throw new Error('AWS mode requires DATABASE_URL, S3_BUCKET, and SES_FROM_EMAIL. See .env.example.');
}
async function localDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try { return JSON.parse(await fs.readFile(localDbPath, 'utf8')); }
  catch { return { users: [], documents: [], approvals: [] }; }
}
async function saveLocal(db) { await fs.writeFile(localDbPath, JSON.stringify(db, null, 2)); }
function publicDocument(d, db) {
  const owner = db.users.find((u) => u.id === d.uploaderId);
  const approvals = db.approvals.filter((a) => a.documentId === d.id);
  return { ...d, uploader: owner && { name: owner.name, email: owner.email }, approvals };
}
function validateEmail(value) { return /^\S+@\S+\.\S+$/.test(value || ''); }

app.get('/api/health', (_req, res) => res.json({ ok: true, mode }));
app.get('/api/documents', async (req, res) => {
  if (aws) {
    const values = []; const filter = req.query.email ? 'WHERE u.email = $1' : '';
    if (req.query.email) values.push(req.query.email);
    const result = await aws.db.query(`SELECT d.*, json_build_object('name', u.name, 'email', u.email) AS uploader,
      COALESCE((SELECT json_agg(a ORDER BY a.created_at) FROM (SELECT id, document_id AS "documentId", reviewer_id AS "reviewerId", decision, comment, created_at AS "createdAt" FROM approvals WHERE document_id=d.id) a), '[]') AS approvals
      FROM documents d JOIN users u ON u.id=d.uploader_id ${filter} ORDER BY d.created_at DESC`, values);
    return res.json(result.rows.map((d) => ({ id: String(d.id), originalName: d.original_name, storageKey: d.storage_key, contentType: d.content_type, sizeBytes: Number(d.size_bytes), status: d.status, createdAt: d.created_at, updatedAt: d.updated_at, uploader: d.uploader, approvals: d.approvals })));
  }
  const db = await localDb();
  const email = req.query.email;
  const docs = db.documents.filter((d) => !email || d.uploaderEmail === email).map((d) => publicDocument(d, db));
  res.json(docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});
app.get('/api/documents/:id/download', async (req, res) => {
  if (aws) {
    const result = await aws.db.query('SELECT original_name, storage_key FROM documents WHERE id=$1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Document unavailable' });
    const doc = result.rows[0];
    const url = await getSignedUrl(aws.s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: doc.storage_key, ResponseContentDisposition: `attachment; filename="${doc.original_name.replaceAll('"', '')}"` }), { expiresIn: 300 });
    return res.redirect(url);
  }
  const db = await localDb(); const doc = db.documents.find((d) => d.id === req.params.id);
  if (!doc || mode !== 'local') return res.status(404).json({ error: 'Document unavailable' });
  res.download(path.join(uploadsDir, doc.localFile), doc.originalName);
});
app.post('/api/documents', upload.single('file'), async (req, res) => {
  const { name, email } = req.body;
  if (!req.file || !name?.trim() || !validateEmail(email)) return res.status(400).json({ error: 'Name, valid email, and a file are required.' });
  if (aws) {
    const key = `documents/${id()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await aws.s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: await fs.readFile(req.file.path), ContentType: req.file.mimetype || 'application/octet-stream', ServerSideEncryption: 'AES256' }));
    await fs.unlink(req.file.path);
    const client = await aws.db.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query("INSERT INTO users (name,email,role) VALUES ($1,$2,'user') ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,email", [name.trim(), email]);
      const inserted = await client.query("INSERT INTO documents (original_name,storage_key,content_type,size_bytes,uploader_id,status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *", [req.file.originalname, key, req.file.mimetype || 'application/octet-stream', req.file.size, owner.rows[0].id]);
      await client.query('COMMIT');
      const d = inserted.rows[0];
      return res.status(201).json({ id: String(d.id), originalName: d.original_name, storageKey: d.storage_key, contentType: d.content_type, sizeBytes: Number(d.size_bytes), status: d.status, createdAt: d.created_at, updatedAt: d.updated_at, uploader: { name: owner.rows[0].name, email: owner.rows[0].email }, approvals: [] });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const db = await localDb();
  let user = db.users.find((u) => u.email === email);
  if (!user) { user = { id: id(), name: name.trim(), email, role: 'user', createdAt: now() }; db.users.push(user); }
  const document = { id: id(), originalName: req.file.originalname, localFile: req.file.filename, storageKey: `documents/${id()}-${req.file.originalname}`, contentType: req.file.mimetype || 'application/octet-stream', sizeBytes: req.file.size, uploaderId: user.id, uploaderEmail: user.email, status: 'pending', createdAt: now(), updatedAt: now() };
  db.documents.push(document); await saveLocal(db);
  res.status(201).json(publicDocument(document, db));
});
app.post('/api/documents/:id/decision', async (req, res) => {
  const { decision, comment, reviewerName = 'Administrator' } = req.body;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  if (aws) {
    const client = await aws.db.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT d.*, u.name AS uploader_name, u.email AS uploader_email FROM documents d JOIN users u ON u.id=d.uploader_id WHERE d.id=$1 FOR UPDATE', [req.params.id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Document not found.' }); }
      const document = found.rows[0];
      if (document.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This document has already been decided.' }); }
      const reviewer = await client.query("INSERT INTO users (name,email,role) VALUES ($1,$2,'admin') ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id", [reviewerName, `admin+${reviewerName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'reviewer'}@docuflow.local`]);
      await client.query('UPDATE documents SET status=$1, updated_at=NOW() WHERE id=$2', [decision, document.id]);
      const approval = await client.query('INSERT INTO approvals (document_id,reviewer_id,decision,comment) VALUES ($1,$2,$3,$4) RETURNING id, decision, comment, created_at AS "createdAt"', [document.id, reviewer.rows[0].id, decision, (comment || '').trim()]);
      await client.query('COMMIT');
      await aws.ses.send(new SendEmailCommand({ Source: process.env.SES_FROM_EMAIL, Destination: { ToAddresses: [document.uploader_email] }, Message: { Subject: { Data: `DocuFlow: document ${decision}` }, Body: { Text: { Data: `Hello ${document.uploader_name},\n\nYour document "${document.original_name}" has been ${decision}.${comment ? `\n\nReviewer note: ${comment}` : ''}\n\nDocuFlow` } } } }));
      return res.json({ id: String(document.id), originalName: document.original_name, storageKey: document.storage_key, contentType: document.content_type, sizeBytes: Number(document.size_bytes), status: decision, createdAt: document.created_at, updatedAt: now(), uploader: { name: document.uploader_name, email: document.uploader_email }, approvals: [approval.rows[0]] });
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  const db = await localDb(); const document = db.documents.find((d) => d.id === req.params.id);
  if (!document) return res.status(404).json({ error: 'Document not found.' });
  if (document.status !== 'pending') return res.status(409).json({ error: 'This document has already been decided.' });
  document.status = decision; document.updatedAt = now();
  const approval = { id: id(), documentId: document.id, reviewerName, decision, comment: (comment || '').trim(), createdAt: now() };
  db.approvals.push(approval); await saveLocal(db);
  console.log(`[LOCAL EMAIL] To: ${document.uploaderEmail} | ${document.originalName} was ${decision}. ${approval.comment}`);
  res.json(publicDocument(document, db));
});
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Unexpected server error.' }); });
await fs.mkdir(uploadsDir, { recursive: true });
app.listen(process.env.PORT || 3000, () => console.log(`Document approval system running at http://localhost:${process.env.PORT || 3000} (${mode} mode)`));
