import type { ConversationFile } from "@opensquad/core";
import { useState } from "react";
import { getApiClient } from "@/lib/api/client.js";

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit++;
  } while (size >= 1024 && unit < units.length - 1);
  const rounded = Number.isInteger(size) ? String(size) : size.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

function FileRow({ conversationId, file }: { conversationId: string; file: ConversationFile }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(false);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setError(false);
    try {
      const client = await getApiClient();
      await client.downloadConversationFile(conversationId, file);
    } catch {
      setError(true);
    } finally {
      setDownloading(false);
    }
  }

  const basename = file.name.split("/").at(-1) || file.name;
  return (
    <li className="chat-file">
      <div className="chat-file-copy">
        <span className="chat-file-name">{file.name}</span>
        <span className="chat-file-size">{fileSize(file.sizeBytes)}</span>
      </div>
      {file.status === "stored" && (
        <button
          type="button"
          className="button text-button chat-file-download"
          aria-label={`Download ${basename}`}
          disabled={downloading}
          onClick={() => void download()}
        >
          {downloading ? "Downloading…" : "Download"}
        </button>
      )}
      {file.status === "too_large" && (
        <span className="chat-file-state">Too large to keep (limit 25 MB)</span>
      )}
      {file.status === "failed" && <span className="chat-file-state">Couldn't save this file</span>}
      {error && (
        <p role="alert" className="chat-file-error">
          Couldn't download this file. Try again.
        </p>
      )}
    </li>
  );
}

export function ConversationFiles({
  conversationId,
  files,
}: {
  conversationId: string;
  files: ConversationFile[];
}) {
  return (
    <section className="chat-files" aria-label="Files">
      <h3 className="chat-files-heading">Files</h3>
      <ul className="chat-files-list">
        {files.map((file) => (
          <FileRow key={file.id} conversationId={conversationId} file={file} />
        ))}
      </ul>
    </section>
  );
}
