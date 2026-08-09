import { expect, type Locator } from "@playwright/test";

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function expectBox(
  locator: Locator,
  expected: Partial<Box>,
  tolerance = 2,
): Promise<void> {
  const box = await locator.boundingBox();

  expect(box, "element must have a rendered bounding box").not.toBeNull();

  if (!box) {
    return;
  }

  for (const key of ["x", "y", "width", "height"] as const) {
    const expectedValue = expected[key];

    if (expectedValue === undefined) {
      continue;
    }

    expect(
      Math.abs(box[key] - expectedValue),
      `${key} expected ${expectedValue}, received ${box[key]}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

export async function expectHorizontalSplit(
  left: Locator,
  right: Locator,
  options: {
    leftRatio: number;
    gap: number;
    ratioTolerance?: number;
    pixelTolerance?: number;
  },
): Promise<void> {
  const [leftBox, rightBox] = await Promise.all([
    left.boundingBox(),
    right.boundingBox(),
  ]);

  expect(leftBox, "left pane must be rendered").not.toBeNull();
  expect(rightBox, "right pane must be rendered").not.toBeNull();

  if (!leftBox || !rightBox) {
    return;
  }

  const pixelTolerance = options.pixelTolerance ?? 2;
  const ratioTolerance = options.ratioTolerance ?? 0.02;
  const gap = rightBox.x - (leftBox.x + leftBox.width);
  const leftRatio = leftBox.width / (leftBox.width + rightBox.width);

  expect(Math.abs(gap - options.gap)).toBeLessThanOrEqual(pixelTolerance);
  expect(Math.abs(leftRatio - options.leftRatio)).toBeLessThanOrEqual(
    ratioTolerance,
  );
}

export async function expectMasonryColumns(
  cards: Locator,
  options: {
    columnLefts: number[];
    columnWidth: number;
    top: number;
    verticalGap: number;
    tolerance?: number;
    minimumDistinctHeights?: number;
  },
): Promise<void> {
  const tolerance = options.tolerance ?? 2;
  const count = await cards.count();

  expect(count).toBeGreaterThanOrEqual(options.columnLefts.length * 2);

  const columns: Box[][] = options.columnLefts.map(() => []);

  for (let index = 0; index < count; index += 1) {
    const box = await cards.nth(index).boundingBox();

    expect(box, `record card ${index + 1} must be rendered`).not.toBeNull();

    if (!box) {
      continue;
    }

    expect(Math.abs(box.width - options.columnWidth)).toBeLessThanOrEqual(
      tolerance,
    );

    let columnIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    options.columnLefts.forEach((left, candidateIndex) => {
      const distance = Math.abs(box.x - left);

      if (distance < closestDistance) {
        columnIndex = candidateIndex;
        closestDistance = distance;
      }
    });

    expect(closestDistance).toBeLessThanOrEqual(tolerance);
    columns[columnIndex]?.push(box);
  }

  for (const column of columns) {
    expect(column.length).toBeGreaterThanOrEqual(2);
    column.sort((a, b) => a.y - b.y);
    expect(Math.abs((column[0]?.y ?? 0) - options.top)).toBeLessThanOrEqual(
      tolerance,
    );

    for (let index = 1; index < column.length; index += 1) {
      const previous = column[index - 1];
      const current = column[index];

      if (!previous || !current) {
        continue;
      }

      const gap = current.y - (previous.y + previous.height);
      expect(Math.abs(gap - options.verticalGap)).toBeLessThanOrEqual(
        tolerance,
      );
    }
  }

  const distinctHeights = new Set(
    columns.flat().map((box) => Math.round(box.height / tolerance)),
  );
  const secondRowTops = new Set(
    columns.map((column) => Math.round((column[1]?.y ?? 0) / tolerance)),
  );

  expect(distinctHeights.size).toBeGreaterThanOrEqual(
    options.minimumDistinctHeights ?? 3,
  );
  expect(secondRowTops.size).toBeGreaterThan(1);
}
