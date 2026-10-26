"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/** 関数のフォルダに置いた写し（functions/shared）が元と同じか。⚠️ 元だけ直すと、ページから始めた解析と PC の解析で答えが変わる */
const root = path.join(__dirname, "..", "..");
for (const [copy, original] of [["functions/shared/roads-lib.js", "public/roads-lib.js"],
                                ["functions/shared/roadPaceCalc.js", "admin/lib/roadPaceCalc.js"]]) {
  test(`${copy} は ${original} と同じ`, () => {
    assert.strictEqual(fs.readFileSync(path.join(root, copy), "utf8"), fs.readFileSync(path.join(root, original), "utf8"),
      "写し直してください（functions/shared/README.md）");
  });
}
