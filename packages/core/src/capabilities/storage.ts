export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
}

/** Object storage capability. Default provider: Supabase Storage. Local dev: local disk. */
export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Uint8Array, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** URL a client can read from for `expiresInSeconds`. */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
