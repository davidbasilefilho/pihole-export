import { expect, test } from "bun:test";

import { secretPaste } from "../src/ui/paste";

test("secret paste reads only on request, discards stale focus and terminal duplicates", async () => {
  let reads = 0;
  let text = "";
  let focused = true;
  const paste = secretPaste(async () => {
    reads++;
    return "synthetic-secret";
  });
  expect(reads).toBe(0);
  paste.request(
    (value) => (text += value),
    () => focused,
  );
  await Bun.sleep(70);
  expect(text).toBe("synthetic-secret");
  paste.request(
    (value) => (text += value),
    () => focused,
  );
  paste.cancel(); // bracketed paste is delivered directly by InputRenderable
  await Bun.sleep(70);
  expect(reads).toBe(1);
  focused = false;
  paste.request(
    (value) => (text += value),
    () => focused,
  );
  await Bun.sleep(70);
  expect(text).toBe("synthetic-secret");
  paste.dispose();
});
