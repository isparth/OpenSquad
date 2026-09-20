import { useEffect, useId, useRef, useState } from "react";
import { getApiClient } from "@/lib/api/client.js";

export function AvatarPicker({
  agentId,
  disabled,
  onChanged,
  onBusyChange,
}: {
  agentId: string;
  disabled: boolean;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function select(next: File | undefined) {
    setError(null);
    setFile(null);
    if (!next) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(next.type) ||
      next.size === 0 ||
      next.size > 2 * 1024 * 1024
    ) {
      setError("Choose a PNG, JPEG or WebP image up to 2 MiB.");
      if (input.current) input.current.value = "";
      return;
    }
    setFile(next);
  }

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const api = await getApiClient();
      await api.uploadAvatar(agentId, file);
      setFile(null);
      if (input.current) input.current.value = "";
      onChanged();
    } catch {
      setError(
        "Avatar could not be saved. Use a valid single-frame image up to 4 million pixels, or try again.",
      );
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="avatar-picker" data-testid="avatar-picker">
      <label htmlFor={id} className="field-label">
        Avatar image
      </label>
      <p className="field-hint" id={`${id}-hint`}>
        PNG, JPEG or WebP · up to 2 MiB · single frame
      </p>
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-describedby={`${id}-hint`}
        disabled={disabled || busy}
        onChange={(event) => select(event.target.files?.[0])}
      />
      {preview && (
        <div className="avatar-preview">
          <img src={preview} alt="Avatar preview" />
          <button
            type="button"
            className="button secondary"
            disabled={busy || disabled}
            onClick={() => void upload()}
          >
            {busy ? "Uploading…" : "Upload avatar"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </div>
  );
}
