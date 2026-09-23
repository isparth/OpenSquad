export type DiffLine = { type: "same" | "added" | "removed"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  const beforeLength = beforeLines.length;
  const afterLength = afterLines.length;
  if (beforeLength * afterLength > 250_000) {
    return [
      ...beforeLines.map((text) => ({ type: "removed" as const, text })),
      ...afterLines.map((text) => ({ type: "added" as const, text })),
    ];
  }

  const lcs = Array.from({ length: beforeLength + 1 }, () => new Uint32Array(afterLength + 1));
  for (let beforeIndex = beforeLength - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterLength - 1; afterIndex >= 0; afterIndex--) {
      const row = lcs[beforeIndex];
      const nextRow = lcs[beforeIndex + 1];
      if (!row || !nextRow) continue;
      row[afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? 1 + (nextRow[afterIndex + 1] ?? 0)
          : Math.max(nextRow[afterIndex] ?? 0, row[afterIndex + 1] ?? 0);
    }
  }

  const result: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLength || afterIndex < afterLength) {
    if (
      beforeIndex < beforeLength &&
      afterIndex < afterLength &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      result.push({ type: "same", text: beforeLines[beforeIndex] ?? "" });
      beforeIndex++;
      afterIndex++;
      continue;
    }

    const currentRow = lcs[beforeIndex];
    const nextRow = lcs[beforeIndex + 1];
    const removeNext =
      beforeIndex < beforeLength &&
      (afterIndex >= afterLength ||
        (nextRow?.[afterIndex] ?? 0) >= (currentRow?.[afterIndex + 1] ?? 0));
    if (removeNext) {
      result.push({ type: "removed", text: beforeLines[beforeIndex] ?? "" });
      beforeIndex++;
    } else if (afterIndex < afterLength) {
      result.push({ type: "added", text: afterLines[afterIndex] ?? "" });
      afterIndex++;
    }
  }
  return result;
}
