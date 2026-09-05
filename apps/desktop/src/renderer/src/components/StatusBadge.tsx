import type { HealthStatus } from "@/features/home/useHealth.js";

export function StatusBadge({ status }: { status: HealthStatus }) {
  switch (status.kind) {
    case "checking":
      return <Badge tone="neutral">Checking API...</Badge>;
    case "up":
      return <Badge tone="green">API up</Badge>;
    case "down":
      return <Badge tone="red">API down: {status.reason}</Badge>;
  }
}

const tones = {
  neutral: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
} as const;

function Badge({ tone, children }: { tone: keyof typeof tones; children: React.ReactNode }) {
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-medium ${tones[tone]}`} role="status">
      {children}
    </span>
  );
}
