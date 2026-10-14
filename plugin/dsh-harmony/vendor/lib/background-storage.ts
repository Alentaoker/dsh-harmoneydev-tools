import {
  CUSTOM_BACKGROUND_DATA_URL_FALLBACK_MAX_BYTES,
  CUSTOM_BACKGROUND_FALLBACK_STORAGE_KEY,
  CUSTOM_BACKGROUND_MAX_BYTES,
  CUSTOM_BACKGROUND_MAX_DIMENSION,
  CUSTOM_BACKGROUND_MAX_PIXELS,
  SUPPORTED_BACKGROUND_MIME_TYPES,
  detectBackgroundImageMime,
  fitCustomBackgroundForRendering,
  isSafeCustomBackgroundDataUrl,
  type SupportedBackgroundMime,
} from "./backgrounds";

const DATABASE_NAME = "piora-appearance";
const DATABASE_VERSION = 1;
const STORE_NAME = "backgrounds";
const ACTIVE_BACKGROUND_KEY = "active";
const FALLBACK_NAME_STORAGE_KEY = "pi-background:custom-name:v1";

export type BackgroundStorageErrorCode =
  | "corrupt-image"
  | "dimensions-too-large"
  | "empty-file"
  | "file-too-large"
  | "missing-custom"
  | "storage-unavailable"
  | "unsupported-type";

export class BackgroundStorageError extends Error {
  constructor(public readonly code: BackgroundStorageErrorCode, message: string) {
    super(message);
    this.name = "BackgroundStorageError";
  }
}

export interface StoredCustomBackground {
  blob: Blob;
  mime: SupportedBackgroundMime;
  name: string;
  updatedAt: number;
}

interface DatabaseBackgroundRecord extends StoredCustomBackground {
  id: typeof ACTIVE_BACKGROUND_KEY;
}

export interface ValidatedBackgroundImage {
  blob: Blob;
  mime: SupportedBackgroundMime;
  width: number;
  height: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new BackgroundStorageError("storage-unavailable", "IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open background storage"));
    request.onblocked = () => reject(new Error("Background storage upgrade is blocked"));
  });
}

async function readDatabaseRecord(): Promise<StoredCustomBackground | null> {
  const database = await openDatabase();
  try {
    const record = await new Promise<DatabaseBackgroundRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_BACKGROUND_KEY);
      request.onsuccess = () => resolve(request.result as DatabaseBackgroundRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("Unable to read custom background"));
    });
    if (!record
      || !(record.blob instanceof Blob)
      || !SUPPORTED_BACKGROUND_MIME_TYPES.includes(record.mime)
      || typeof record.name !== "string"
      || typeof record.updatedAt !== "number") {
      return null;
    }
    return { blob: record.blob, mime: record.mime, name: record.name, updatedAt: record.updatedAt };
  } finally {
    database.close();
  }
}

async function writeDatabaseRecord(record: StoredCustomBackground): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: ACTIVE_BACKGROUND_KEY, ...record } satisfies DatabaseBackgroundRecord);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save custom background"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving custom background was aborted"));
    });
  } finally {
    database.close();
  }
}

async function deleteDatabaseRecord(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(ACTIVE_BACKGROUND_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to remove custom background"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Removing custom background was aborted"));
    });
  } finally {
    database.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Unable to encode custom background"));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to encode custom background"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: SupportedBackgroundMime } | null {
  if (!isSafeCustomBackgroundDataUrl(dataUrl)) return null;
  const separator = dataUrl.indexOf(",");
  const mime = dataUrl.slice(5, dataUrl.indexOf(";")) as SupportedBackgroundMime;
  try {
    const binary = atob(dataUrl.slice(separator + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (detectBackgroundImageMime(bytes.slice(0, 32)) !== mime) return null;
    return { blob: new Blob([bytes], { type: mime }), mime };
  } catch {
    return null;
  }
}

function clearFallbackStorage(): void {
  try {
    localStorage.removeItem(CUSTOM_BACKGROUND_FALLBACK_STORAGE_KEY);
    localStorage.removeItem(FALLBACK_NAME_STORAGE_KEY);
  } catch {
    // Storage cleanup is best-effort.
  }
}

function readFallbackRecord(): StoredCustomBackground | null {
  try {
    const encoded = localStorage.getItem(CUSTOM_BACKGROUND_FALLBACK_STORAGE_KEY);
    const decoded = encoded ? dataUrlToBlob(encoded) : null;
    if (!decoded) return null;
    return {
      blob: decoded.blob,
      mime: decoded.mime,
      name: localStorage.getItem(FALLBACK_NAME_STORAGE_KEY) || "Local background",
      updatedAt: 0,
    };
  } catch {
    return null;
  }
}

export async function readCustomBackground(): Promise<StoredCustomBackground | null> {
  try {
    const record = await readDatabaseRecord();
    if (record) return record;
  } catch {
    // A small data URL fallback keeps the feature usable when IndexedDB is disabled.
  }
  return readFallbackRecord();
}

export async function saveCustomBackground(record: StoredCustomBackground): Promise<void> {
  try {
    await writeDatabaseRecord(record);
    clearFallbackStorage();
    return;
  } catch {
    if (record.blob.size > CUSTOM_BACKGROUND_DATA_URL_FALLBACK_MAX_BYTES) {
      throw new BackgroundStorageError(
        "storage-unavailable",
        "IndexedDB is unavailable and the image is too large for safe localStorage fallback",
      );
    }
  }

  try {
    const encoded = await blobToDataUrl(record.blob);
    if (!isSafeCustomBackgroundDataUrl(encoded)) throw new Error("Unsafe encoded background");
    localStorage.setItem(CUSTOM_BACKGROUND_FALLBACK_STORAGE_KEY, encoded);
    localStorage.setItem(FALLBACK_NAME_STORAGE_KEY, record.name);
  } catch {
    throw new BackgroundStorageError("storage-unavailable", "Browser storage is unavailable");
  }
}

export async function deleteCustomBackground(): Promise<void> {
  try {
    await deleteDatabaseRecord();
  } catch {
    // The fallback may still be removable even if IndexedDB is unavailable.
  }
  clearFallbackStorage();
}

async function decodeImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      throw new BackgroundStorageError("corrupt-image", "The selected image cannot be decoded");
    }
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new BackgroundStorageError("corrupt-image", "The selected image cannot be decoded"));
    };
    image.src = objectUrl;
  });
}

async function resizeForSafeRendering(
  blob: Blob,
  mime: SupportedBackgroundMime,
  width: number,
  height: number,
): Promise<ValidatedBackgroundImage> {
  const target = fitCustomBackgroundForRendering(width, height);
  if (target.width === width && target.height === height) return { blob, mime, width, height };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: "high",
    });
  } catch {
    throw new BackgroundStorageError("corrupt-image", "The selected image cannot be prepared for safe rendering");
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new BackgroundStorageError("storage-unavailable", "Image rendering is unavailable");
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const outputMime: SupportedBackgroundMime = mime === "image/jpeg" ? "image/jpeg" : "image/webp";
    const resized = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new BackgroundStorageError("storage-unavailable", "Unable to optimize the selected image")),
        outputMime,
        0.92,
      );
    });
    return { blob: resized, mime: outputMime, width: target.width, height: target.height };
  } finally {
    bitmap.close();
  }
}

export async function validateCustomBackgroundFile(file: File): Promise<ValidatedBackgroundImage> {
  if (file.size <= 0) throw new BackgroundStorageError("empty-file", "The selected image is empty");
  if (file.size > CUSTOM_BACKGROUND_MAX_BYTES) {
    throw new BackgroundStorageError("file-too-large", "The selected image exceeds the 12 MiB limit");
  }

  const signature = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const mime = detectBackgroundImageMime(signature);
  if (!mime) {
    throw new BackgroundStorageError("unsupported-type", "Choose a PNG, JPEG, WebP, or AVIF image");
  }
  if (file.type && file.type !== "application/octet-stream" && file.type !== mime) {
    throw new BackgroundStorageError("unsupported-type", "The file type does not match its image data");
  }

  const blob = file.slice(0, file.size, mime);
  const { width, height } = await decodeImageDimensions(blob);
  if (width <= 0 || height <= 0) {
    throw new BackgroundStorageError("corrupt-image", "The selected image has invalid dimensions");
  }
  if (width > CUSTOM_BACKGROUND_MAX_DIMENSION
    || height > CUSTOM_BACKGROUND_MAX_DIMENSION
    || width * height > CUSTOM_BACKGROUND_MAX_PIXELS) {
    throw new BackgroundStorageError("dimensions-too-large", "The selected image dimensions are too large");
  }

  return await resizeForSafeRendering(blob, mime, width, height);
}
