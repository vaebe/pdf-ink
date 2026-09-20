import type { SignatureTemplate } from "../types/signature";

interface SignatureRecord {
  id: string;
  blob: Blob;
  pixelWidth: number;
  pixelHeight: number;
  createdAt: number;
}

const DATABASE_NAME = "pdf-ink";
const DATABASE_VERSION = 1;
const STORE_NAME = "signatures";

let databasePromise: Promise<IDBDatabase> | null = null;

/** 打开签名库数据库，模式与存储区在升级时创建。 */
function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("无法打开本地签名库。"));
      };
      request.onblocked = () => {
        reject(new Error("本地签名库已被其他页面占用，请关闭其他标签页后重试。"));
      };
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function toTemplate(record: SignatureRecord): SignatureTemplate {
  // 旧版本写入的记录可能带有多余的 name 字段，读取时直接忽略即可。
  return {
    id: record.id,
    blob: record.blob,
    pixelWidth: record.pixelWidth,
    pixelHeight: record.pixelHeight,
    createdAt: record.createdAt,
  };
}

/**
 * 在单个事务中执行一次读写，并以事务完成作为成功条件。
 * 请求本身成功但事务中止时同样视为失败，避免出现虚假的成功状态。
 */
function runTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(STORE_NAME, mode);
        } catch (error) {
          reject(error);
          return;
        }

        let request: IDBRequest;
        try {
          request = run(transaction.objectStore(STORE_NAME));
        } catch (error) {
          transaction.abort();
          reject(error);
          return;
        }

        const holder: { value?: T } = {};
        request.onsuccess = () => {
          holder.value = request.result as T;
        };
        transaction.oncomplete = () => {
          resolve(holder.value as T);
        };
        transaction.onerror = () => {
          reject(transaction.error ?? new Error("本地签名库操作失败。"));
        };
        transaction.onabort = () => {
          reject(transaction.error ?? request.error ?? new Error("本地签名库操作已中止。"));
        };
      }),
  );
}

/** 读取全部签名模板，按创建时间升序返回。 */
export async function listSignatureTemplates(): Promise<SignatureTemplate[]> {
  const records = await runTransaction<SignatureRecord[]>("readonly", (store) => store.getAll());
  return records.map(toTemplate).sort((left, right) => left.createdAt - right.createdAt);
}

/** 新增或覆盖一个签名模板。 */
export async function putSignatureTemplate(template: SignatureTemplate): Promise<void> {
  const record: SignatureRecord = {
    id: template.id,
    blob: template.blob,
    pixelWidth: template.pixelWidth,
    pixelHeight: template.pixelHeight,
    createdAt: template.createdAt,
  };
  await runTransaction("readwrite", (store) => store.put(record));
}

/** 删除指定签名模板。 */
export async function deleteSignatureTemplate(id: string): Promise<void> {
  await runTransaction("readwrite", (store) => store.delete(id));
}
