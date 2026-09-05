import type { StorageProvider, StoredObject } from "@opensquad/core";

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

/**
 * Supabase Storage provider. The only place `@supabase/supabase-js` may be imported.
 * TODO: implement with the SDK once avatars are wired up.
 */
export class SupabaseStorageProvider implements StorageProvider {
  readonly name = "supabase";

  constructor(protected readonly options: SupabaseStorageOptions) {}

  put(_key: string, _data: Uint8Array, _contentType?: string): Promise<StoredObject> {
    return Promise.reject(new Error(`${this.name} storage: not implemented`));
  }

  get(_key: string): Promise<Uint8Array | null> {
    return Promise.reject(new Error(`${this.name} storage: not implemented`));
  }

  delete(_key: string): Promise<void> {
    return Promise.reject(new Error(`${this.name} storage: not implemented`));
  }

  getSignedUrl(_key: string, _expiresInSeconds: number): Promise<string> {
    return Promise.reject(new Error(`${this.name} storage: not implemented`));
  }
}
