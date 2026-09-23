import type { ConversationMessage, MessageContentPart } from "@opensquad/core";
import { useState } from "react";

const ANSI_ESCAPE_CHARACTER = String.fromCharCode(0x1b);
const ANSI_ESCAPE = new RegExp(`${ANSI_ESCAPE_CHARACTER}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SHELL_WRAPPER = /^\/bin\/(ba)?sh -lc "(.*)"$/s;

type CommandPart = Extract<MessageContentPart, { type: "command" }>;

function displayCommand(command: string): string {
  const match = command.match(SHELL_WRAPPER);
  return match?.[2]?.replace(/\\"/g, '"') ?? command;
}

function statusLabel(status: ConversationMessage["status"], exitCode: number | null): string {
  if (status === "running") return "Running…";
  if (status === "incomplete") return "Failed";
  if (exitCode === null) return "Completed";
  return `Exit ${exitCode}`;
}

export function CommandRow({
  part,
  status,
}: {
  part: CommandPart;
  status: ConversationMessage["status"];
}) {
  const [expanded, setExpanded] = useState(false);
  const command = displayCommand(part.command);
  const output = part.output.replace(ANSI_ESCAPE, "");
  const label = statusLabel(status, part.exitCode);
  const danger =
    status === "incomplete" ||
    (status === "completed" && part.exitCode !== null && part.exitCode !== 0);

  return (
    <section className="command-row" aria-label="Command execution">
      <div className="command-row-heading">
        <span className="command-row-action">Ran</span>
        <code className="command-row-command" title={command}>
          {command}
        </code>
      </div>
      <div className="command-row-meta">
        <span className={`command-row-status${danger ? " danger" : ""}`}>{label}</span>
        {part.durationMs !== null && (
          <span className="command-row-duration">{(part.durationMs / 1000).toFixed(1)} s</span>
        )}
      </div>
      <button
        type="button"
        className="button text-button command-row-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide output" : "Show output"}
      </button>
      {expanded && (
        <div className="command-row-output">
          <pre>{output || "No output"}</pre>
          {part.outputTruncated && <p>Output was truncated</p>}
        </div>
      )}
    </section>
  );
}
