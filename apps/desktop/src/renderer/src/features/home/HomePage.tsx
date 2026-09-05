import { StatusBadge } from "@/components/StatusBadge.js";
import { useHealth } from "./useHealth.js";

export function HomePage() {
  const { status, check } = useHealth();

  return (
    <section className="flex flex-col items-center gap-6">
      <h1 className="text-4xl font-semibold tracking-tight">Hello world</h1>
      <StatusBadge status={status} />
      <button
        type="button"
        onClick={() => void check()}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Check API
      </button>
    </section>
  );
}
