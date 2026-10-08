import crypto from 'node:crypto';
import fs from 'node:fs';

const TABLES = [
  ['accounts', 'id'],
  ['classes', 'id'],
  ['pupils', 'id'],
  ['template_sets', 'id'],
  ['templates', 'id'],
  ['assignments', 'id'],
  ['pupil_assignments', 'id'],
  ['sessions', 'token'],
  ['images', 'id'],
];
const DELETE_ORDER = [...TABLES].reverse();
const COLLECTION = process.env.FIREBASE_COLLECTION || 'y6_sqlite_rows_v1';
const DEFAULT_SERVICE_ACCOUNT_PATH = '/etc/secrets/firebase-service-account.json';
const IMAGE_CHUNK_BYTES = 500 * 1024;

let firestore = null;
let dirty = false;
let flushing = null;
let baseline = new Map();

function documentId(table, key) {
  return `${table}__${Buffer.from(String(key)).toString('base64url')}`;
}

function rowHash(row) {
  const json = JSON.stringify(row, (_key, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { __bytes: Buffer.from(value).toString('base64') };
    }
    return value;
  });
  return crypto.createHash('sha256').update(json).digest('hex');
}

function currentRows(db) {
  const rows = new Map();
  for (const [table, primaryKey] of TABLES) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const key = String(row[primaryKey]);
      rows.set(`${table}:${key}`, { table, key, row, hash: rowHash(row) });
    }
  }
  return rows;
}

function decodeServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const serviceAccountPath = configuredPath
    || (fs.existsSync(DEFAULT_SERVICE_ACCOUNT_PATH) ? DEFAULT_SERVICE_ACCOUNT_PATH : null);
  if (!raw && !serviceAccountPath) return null;
  const account = JSON.parse(raw || fs.readFileSync(serviceAccountPath, 'utf8'));
  if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
  return account;
}

function toSqlValue(value) {
  if (value && typeof value.toBuffer === 'function') return value.toBuffer();
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}

async function commitOperations(operations) {
  for (let start = 0; start < operations.length; start += 400) {
    const batch = firestore.batch();
    for (const op of operations.slice(start, start + 400)) {
      if (op.type === 'delete') batch.delete(op.ref);
      else batch.set(op.ref, op.data);
    }
    await batch.commit();
  }
}

export async function restoreCloudDatabase(db) {
  const serviceAccount = decodeServiceAccount();
  if (!serviceAccount) return { enabled: false, restored: 0 };

  const [{ initializeApp, cert }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const app = initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id,
  }, 'year6-cloud-store');
  firestore = getFirestore(app);
  firestore.settings({ ignoreUndefinedProperties: true });

  const snapshot = await firestore.collection(COLLECTION).get();
  if (snapshot.empty) return { enabled: true, restored: 0 };

  const storedRows = new Map();
  const imageChunks = new Map();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.kind === 'image-chunk') {
      const chunks = imageChunks.get(data.rowKey) || [];
      chunks[data.index] = data.data;
      imageChunks.set(data.rowKey, chunks);
    } else if (data.kind === 'row' && data.table && data.key != null) {
      storedRows.set(`${data.table}:${data.key}`, data);
    }
  }

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const [table] of DELETE_ORDER) db.exec(`DELETE FROM ${table};`);
    for (const [table] of TABLES) {
      const tableRows = [...storedRows.values()].filter((item) => item.table === table);
      for (const item of tableRows) {
        const row = { ...item.row };
        if (table === 'images') {
          const chunks = imageChunks.get(`${table}:${item.key}`) || [];
          row.data = Buffer.from(chunks.join(''), 'base64');
        }
        const columns = Object.keys(row);
        const placeholders = columns.map(() => '?').join(',');
        const values = columns.map((column) => toSqlValue(row[column]));
        db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`).run(...values);
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  baseline = currentRows(db);
  return { enabled: true, restored: baseline.size };
}

export function markCloudDirty() {
  if (firestore) dirty = true;
}

async function performFlush(db) {
  const current = currentRows(db);
  const operations = [];

  for (const [rowKey, previous] of baseline) {
    if (current.has(rowKey)) continue;
    operations.push({
      type: 'delete',
      ref: firestore.collection(COLLECTION).doc(documentId(previous.table, previous.key)),
    });
    if (previous.table === 'images') {
      const chunkCount = Math.ceil(Buffer.from(previous.row.data).length / IMAGE_CHUNK_BYTES);
      for (let index = 0; index < chunkCount; index += 1) {
        operations.push({
          type: 'delete',
          ref: firestore.collection(COLLECTION).doc(`${documentId('images', previous.key)}__chunk_${index}`),
        });
      }
    }
  }

  for (const [rowKey, item] of current) {
    const previous = baseline.get(rowKey);
    if (previous?.hash === item.hash) continue;

    const ref = firestore.collection(COLLECTION).doc(documentId(item.table, item.key));
    if (item.table !== 'images') {
      operations.push({
        type: 'set',
        ref,
        data: { kind: 'row', table: item.table, key: item.key, row: item.row },
      });
      continue;
    }

    const bytes = Buffer.from(item.row.data);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += IMAGE_CHUNK_BYTES) {
      chunks.push(bytes.subarray(offset, offset + IMAGE_CHUNK_BYTES).toString('base64'));
    }
    const row = { ...item.row };
    delete row.data;
    operations.push({
      type: 'set',
      ref,
      data: { kind: 'row', table: item.table, key: item.key, row, imageChunks: chunks.length },
    });
    for (let index = 0; index < chunks.length; index += 1) {
      operations.push({
        type: 'set',
        ref: firestore.collection(COLLECTION).doc(`${documentId('images', item.key)}__chunk_${index}`),
        data: { kind: 'image-chunk', rowKey, index, data: chunks[index] },
      });
    }
    const oldCount = previous ? Math.ceil(Buffer.from(previous.row.data).length / IMAGE_CHUNK_BYTES) : 0;
    for (let index = chunks.length; index < oldCount; index += 1) {
      operations.push({
        type: 'delete',
        ref: firestore.collection(COLLECTION).doc(`${documentId('images', item.key)}__chunk_${index}`),
      });
    }
  }

  if (operations.length) await commitOperations(operations);
  baseline = current;
}

export async function flushCloudDatabase(db) {
  if (!firestore || (!dirty && !flushing)) return;
  if (!flushing) {
    flushing = (async () => {
      try {
        while (dirty) {
          dirty = false;
          try {
            await performFlush(db);
          } catch (error) {
            dirty = true;
            throw error;
          }
        }
      } finally {
        flushing = null;
      }
    })();
  }
  await flushing;
}

export function cloudStoreEnabled() {
  return Boolean(firestore);
}
