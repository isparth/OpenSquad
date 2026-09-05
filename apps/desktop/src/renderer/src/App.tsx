import { HomePage } from "@/features/home/HomePage.js";

export function App() {
  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="titlebar-drag h-9 shrink-0" />
      <main className="flex flex-1 items-center justify-center">
        <HomePage />
      </main>
    </div>
  );
}
