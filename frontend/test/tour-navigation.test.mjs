import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTour, initialAlbumTour } from "../src/lib/api.ts";

test("one tour opens directly, while multiple tours preserve explicit overview and tour links", () => {
  const first = { ...emptyTour(), id: "one", date: "2026-01-01" };
  const second = { ...emptyTour(), id: "two", date: "2026-01-02" };
  assert.equal(initialAlbumTour([], null, false), null);
  assert.equal(initialAlbumTour([first], null, false), first);
  assert.equal(initialAlbumTour([first], null, true), first);
  const undated = { ...first, date: null };
  assert.equal(initialAlbumTour([undated], null, false), undated);
  assert.equal(initialAlbumTour([first, second], null, false), null);
  assert.equal(initialAlbumTour([first, second], "two", false), second);
  assert.equal(initialAlbumTour([first, second], "two", true), null);
});