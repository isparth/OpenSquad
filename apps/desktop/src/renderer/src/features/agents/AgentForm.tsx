import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { type AgentInput, type AgentRecord, getApiClient } from "@/lib/api/client.js";

interface Props {
  agent?: AgentRecord;
  onSaved: (agent: AgentRecord) => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}

export function AgentForm({ agent, onSaved, onCancel, onBusyChange }: Props) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState({
    name: agent?.name ?? "",
    label: agent?.label ?? "",
    description: agent?.description ?? "",
    instructions: agent?.instructions ?? "",
    sandboxEnabled: agent?.sandboxEnabled ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const change = (field: Exclude<keyof AgentInput, "sandboxEnabled">, value: string) =>
    setDraft((previous) => ({ ...previous, [field]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!draft.name.trim()) {
      setError("Give your bot a name.");
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const input = { ...draft, name: draft.name.trim(), label: draft.label.trim() || null };
      const api = await getApiClient();
      onSaved(await (agent ? api.updateAgent(agent.id, input) : api.createAgent(input)));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save bot");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <form
      className="agent-form"
      data-testid="agent-form"
      onSubmit={(event) => void submit(event)}
      aria-labelledby={`${id}-title`}
    >
      <div className="section-heading">
        <p className="eyebrow">{agent ? "Bot settings" : "Build your team"}</p>
        <h2 id={`${id}-title`}>{agent ? "Edit bot" : "Create a bot"}</h2>
        <p className="muted">Give your bot a purpose. You can change these details anytime.</p>
      </div>
      <fieldset disabled={busy}>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${id}-name`}>Bot name</label>
            <input
              ref={nameRef}
              id={`${id}-name`}
              value={draft.name}
              onChange={(event) => change("name", event.target.value)}
              maxLength={100}
              required
              placeholder="e.g. Atlas"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-label`}>Label (optional)</label>
            <input
              id={`${id}-label`}
              value={draft.label}
              onChange={(event) => change("label", event.target.value)}
              maxLength={50}
              placeholder="e.g. Research"
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-description`}>Description</label>
          <textarea
            id={`${id}-description`}
            value={draft.description}
            onChange={(event) => change("description", event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="What will this bot help you with?"
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-instructions`}>Instructions</label>
          <p id={`${id}-hint`} className="field-hint">
            Describe how this bot should work, including its tone and boundaries.
          </p>
          <textarea
            id={`${id}-instructions`}
            aria-describedby={`${id}-hint`}
            className="instructions-input"
            value={draft.instructions}
            onChange={(event) => change("instructions", event.target.value)}
            maxLength={20000}
            rows={7}
            placeholder="You are a thoughtful research assistant…"
          />
        </div>
        <div className="field sandbox-field">
          <div className="switch-option">
            <input
              id={`${id}-sandbox`}
              type="checkbox"
              role="switch"
              checked={draft.sandboxEnabled}
              aria-checked={draft.sandboxEnabled}
              aria-describedby={`${id}-sandbox-hint`}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, sandboxEnabled: event.target.checked }))
              }
            />
            <label htmlFor={`${id}-sandbox`}>Sandbox</label>
          </div>
          <p id={`${id}-sandbox-hint`} className="field-hint">
            Lets this bot run code and work with files in an OpenAI-hosted sandbox. Off by default,
            and it may add cost on your OpenAI account. Changes apply to new conversations.
          </p>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error-message">
          {error}. Your draft is still here; check the bot list before retrying an uncertain create.
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy} data-testid="save-agent">
          {busy ? "Saving…" : agent ? "Save changes" : "Create bot"}
        </button>
      </div>
    </form>
  );
}
