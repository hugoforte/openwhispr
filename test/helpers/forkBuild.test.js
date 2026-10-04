const test = require("node:test");
const assert = require("node:assert/strict");

const { forkUpdateVersion } = require("../../src/helpers/forkBuild");

test("a fork build orders after the upstream version it is built from", () => {
  assert.equal(forkUpdateVersion("1.10.2", 3), "1.10.2-hf.3");
});

test("a build without a fork build number keeps the plain app version", () => {
  assert.equal(forkUpdateVersion("1.10.2", undefined), null);
});

test("a fork build number that is not a positive integer is ignored", () => {
  assert.equal(forkUpdateVersion("1.10.2", "1; rm"), null);
});
