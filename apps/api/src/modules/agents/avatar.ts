import type { StorageProvider } from "@opensquad/core";
import sharp from "sharp";

export const avatarMaxBytes = 2 * 1024 * 1024;
export const avatarFilePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpeg|webp)$/;
const imageTypes = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

export function avatarPath(agentId: string, file: string): string {
  return `/agents/${agentId}/avatar/${file}`;
}

export function avatarKey(agentId: string, url: string | null): string | null {
  const prefix = `/agents/${agentId}/avatar/`;
  if (!url?.startsWith(prefix)) return null;
  const file = url.slice(prefix.length);
  return avatarFilePattern.test(file) ? `avatars/${agentId}/${file}` : null;
}

export async function validateAvatar(
  data: Buffer,
  contentType: string,
): Promise<keyof typeof imageTypes> {
  if (
    !data.length ||
    data.length > avatarMaxBytes ||
    !Object.values(imageTypes).some((type) => type === contentType)
  ) {
    throw new Error("Use a PNG, JPEG or WebP image up to 2 MiB");
  }
  const format = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "png"
    : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? "jpeg"
      : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP"
        ? "webp"
        : null;
  if (!format || imageTypes[format] !== contentType) throw new Error("Unsupported image");
  if (format === "png") {
    for (let offset = 8; offset + 12 <= data.length; ) {
      const end = offset + data.readUInt32BE(offset) + 12;
      if (end > data.length) throw new Error("Truncated PNG chunk");
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") throw new Error("Animated PNG is not supported");
      if (type === "IEND") break;
      offset = end;
    }
  }
  const image = sharp(data, { limitInputPixels: 4_000_000, failOn: "warning" }).timeout({
    seconds: 5,
  });
  try {
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) {
      throw new Error("Unsupported image");
    }
    await image.stats();
    return format;
  } finally {
    image.destroy();
  }
}

export async function removeAvatar(
  storage: StorageProvider,
  agentId: string,
  url: string | null,
  onFailure: () => void,
): Promise<void> {
  const key = avatarKey(agentId, url);
  if (!key) return;
  try {
    await storage.delete(key);
  } catch {
    onFailure();
  }
}
