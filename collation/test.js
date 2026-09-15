"use strict";

/**
 * 自动化测试：node --test collation/
 * 覆盖：换位（相邻/移动）、连续缺字计权、缺页标记、异体归并与冲突整批拒绝、
 *       底本选择与同分规则、人工锁定与重算保留、回滚、并发登记、断点续跑、支撑版本。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { alignDetailed, charToken, gapToken } = require("./align");
const store = require("./store");
const { createServer } = require("./server");

function toks(str) {
  return [...str].map((ch) => charToken(ch, ch));
}

// ---------------- 对齐引擎单元测试 ----------------

test("换位：相邻互换只算一次", () => {
  const r = alignDetailed([..."甲乙"], toks("乙甲"));
  assert.equal(r.cost, 1);
  assert.equal(r.stats.transposition, 1);
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].type, "transposition");
  assert.deepEqual(r.ops[0].baseChars, ["甲", "乙"]);
  assert.deepEqual(r.ops[0].chars, ["乙", "甲"]);
});

test("换位：整块移动只算一次", () => {
  const r = alignDetailed([..."甲乙丙丁"], toks("甲丙丁乙"));
  assert.equal(r.cost, 1);
  assert.equal(r.stats.transposition, 1);
  assert.equal(r.ops[0].type, "transposition");
  assert.deepEqual(r.ops[0].baseChars, ["乙"]);
});

test("连续缺字按一段计权", () => {
  const r = alignDetailed([..."甲乙丙丁戊"], toks("甲戊"));
  assert.equal(r.cost, 1);
  assert.equal(r.stats.missing, 1);
  assert.equal(r.stats.missingChars, 3);
  assert.deepEqual(r.ops[0].chars, ["乙", "丙", "丁"]);
});

test("插入连续段按一段计权", () => {
  const r = alignDetailed([..."甲乙"], toks("甲丙丁乙"));
  assert.equal(r.cost, 1);
  assert.equal(r.stats.insert, 1);
  assert.equal(r.stats.insertChars, 2);
});

test("缺页标记不当缺字：代价为 0 且类型为 missing_page", () => {
  const tokens = [...toks("甲"), gapToken(), ...toks("丁")];
  const r = alignDetailed([..."甲乙丙丁"], tokens);
  assert.equal(r.cost, 0);
  assert.equal(r.stats.missing, 0);
  assert.equal(r.stats.missingPage, 1);
  assert.equal(r.stats.missingPageChars, 2);
  assert.equal(r.ops[0].type, "missing_page");
  assert.deepEqual(r.ops[0].chars, ["乙", "丙"]);
});

// ---------------- HTTP 接口测试 ----------------

let server;
let port;

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function makeText(title = "测试文本") {
  const r = await api("POST", "/texts", { title });
  assert.equal(r.status, 201);
  return r.body.data;
}

async function addVersion(textId, code, columns) {
  return api("POST", `/texts/${textId}/versions`, { code, columns });
}

/** 便捷造列：字符串 -> 字列；{page:true} -> 缺页列 */
function cols(...items) {
  return items.map((it, i) =>
    typeof it === "string" ? { no: i + 1, chars: it } : { no: i + 1, missingPage: true }
  );
}

test.before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collation-test-"));
  await store.init(path.join(dir, "db.json"));
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
});

test("登记版本后校勘结果立即更新", async () => {
  const text = await makeText();
  const r = await addVersion(text.id, "甲本", cols("天地", "玄黄"));
  assert.equal(r.status, 201);
  const version = r.body.data;
  assert.equal(r.body.collation.baseVersionId, version.id);
  assert.equal(r.body.collation.baseText, "天地玄黄");

  const q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.status, 200);
  assert.equal(q.body.data.baseText, "天地玄黄");
  assert.equal(q.body.data.versions.length, 1);
  assert.equal(q.body.data.versions[0].id, version.id);
});

test("底本选择：总编辑代价最小，同分先早登记", async () => {
  const text = await makeText();
  const v1 = (await addVersion(text.id, "v1", cols("甲乙丙"))).body.data;
  const v2 = (await addVersion(text.id, "v2", cols("甲乙丙"))).body.data;
  const v3 = (await addVersion(text.id, "v3", cols("甲乙丁"))).body.data;

  let q = await api("GET", `/texts/${text.id}/collation`);
  // v1/v2 总代价 1，v3 总代价 2；同分取先登记的 v1
  assert.equal(q.body.data.costs[v1.id], 1);
  assert.equal(q.body.data.costs[v3.id], 2);
  assert.equal(q.body.data.baseVersionId, v1.id);

  // 删除 v1 后 v2/v3 同分，取先登记的 v2
  const d = await api("DELETE", `/texts/${text.id}/versions/${v1.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.collation.baseVersionId, v2.id);
});

test("支撑版本：逐位给出相同字的版本列表", async () => {
  const text = await makeText();
  const v1 = (await addVersion(text.id, "v1", cols("甲乙丙"))).body.data;
  const v2 = (await addVersion(text.id, "v2", cols("甲乙丁"))).body.data;
  const v3 = (await addVersion(text.id, "v3", cols("甲乙丙"))).body.data;

  const q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.body.data.baseVersionId, v1.id);
  const col2 = q.body.data.columns[2];
  assert.equal(col2.char, "丙");
  assert.deepEqual(col2.support.sort(), [v1.id, v3.id].sort());
  assert.ok(!col2.support.includes(v2.id));
});

test("换位只算一次（接口级）", async () => {
  const text = await makeText();
  await addVersion(text.id, "v1", cols("甲乙丙丁"));
  const v2 = (await addVersion(text.id, "v2", cols("甲丙丁乙"))).body.data;
  const q = await api("GET", `/texts/${text.id}/collation`);
  const report = q.body.data.versions.find((v) => v.id === v2.id);
  assert.equal(report.stats.transposition, 1);
  assert.equal(report.cost, 1);
  assert.equal(report.diff[0].type, "transposition");
});

test("缺页标记：不计缺字、代价为 0", async () => {
  const text = await makeText();
  const v1 = (await addVersion(text.id, "足本", cols("天地玄黄", "宇宙洪荒"))).body.data;
  const v2 = (
    await addVersion(text.id, "残本", [
      { no: 1, chars: "天地" },
      { no: 2, missingPage: true },
      { no: 3, chars: "宇宙洪荒" }
    ])
  ).body.data;

  const q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.body.data.baseVersionId, v1.id); // 残本因缺页不受罚，但足本代价更低
  const report = q.body.data.versions.find((v) => v.id === v2.id);
  assert.equal(report.cost, 0);
  assert.equal(report.stats.missing, 0);
  assert.equal(report.stats.missingPage, 1);
  assert.equal(report.diff[0].type, "missing_page");
  assert.deepEqual(report.diff[0].chars, ["玄", "黄"]);
});

test("缺页列登记字 → 400；重复版本编号 → 409", async () => {
  const text = await makeText();
  const bad = await addVersion(text.id, "v1", [{ no: 1, chars: "甲", missingPage: true }]);
  assert.equal(bad.status, 400);
  const ok = await addVersion(text.id, "v1", cols("甲乙"));
  assert.equal(ok.status, 201);
  const dup = await addVersion(text.id, "v1", cols("甲乙"));
  assert.equal(dup.status, 409);
});

test("异体字归并为标准字后视为相同", async () => {
  const text = await makeText();
  const put = await api("PUT", `/texts/${text.id}/variants`, {
    groups: [{ standard: "黄", members: ["黃", "皇"] }]
  });
  assert.equal(put.status, 200);

  const v1 = (await addVersion(text.id, "v1", cols("天地玄黄"))).body.data;
  const v2 = (await addVersion(text.id, "v2", cols("天地玄黃"))).body.data;
  const q = await api("GET", `/texts/${text.id}/collation`);
  const report = q.body.data.versions.find((v) => v.id === v2.id);
  assert.equal(report.cost, 0);
  assert.equal(report.diff.length, 0);
  const col3 = q.body.data.columns[3];
  assert.deepEqual(col3.support.sort(), [v1.id, v2.id].sort());
});

test("异体组冲突整批拒绝，已有状态不变", async () => {
  const text = await makeText();
  // 标准字多字 → 拒绝
  let r = await api("PUT", `/texts/${text.id}/variants`, {
    groups: [{ standard: "黄皇", members: ["黃"] }]
  });
  assert.equal(r.status, 409);
  // 一字出现在两个组 → 冲突
  r = await api("PUT", `/texts/${text.id}/variants`, {
    groups: [
      { standard: "黄", members: ["黃"] },
      { standard: "黃", members: ["皇"] }
    ]
  });
  assert.equal(r.status, 409);
  assert.ok(r.body.error.includes("整批已拒绝"));
  assert.ok(r.body.conflicts.length > 0);

  const q = await api("GET", `/texts/${text.id}/variants`);
  assert.deepEqual(q.body.data, []); // 整批拒绝，未写入任何组

  // 合法批次可以写入
  r = await api("PUT", `/texts/${text.id}/variants`, {
    groups: [{ standard: "黄", members: ["黃"] }]
  });
  assert.equal(r.status, 200);
  const q2 = await api("GET", `/texts/${text.id}/variants`);
  assert.equal(q2.body.data.length, 1);
});

test("人工锁定：换底本后锁定段位置与用字保持不变", async () => {
  const text = await makeText();
  await addVersion(text.id, "v1", cols("甲乙丙丁"));
  await addVersion(text.id, "v2", cols("甲乙玄黄"));
  let q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.body.data.baseText, "甲乙丙丁"); // 同分取先登记

  // 锁定 [2,4) = 丙丁
  const lock = await api("POST", `/texts/${text.id}/locks`, { start: 2, end: 4, note: "名家校定" });
  assert.equal(lock.status, 201);
  assert.equal(lock.body.data.chars, "丙丁");

  // 再登记两个「甲乙玄黄」，底本易主，但锁定段不动
  const v3 = (await addVersion(text.id, "v3", cols("甲乙玄黄"))).body.data;
  await addVersion(text.id, "v4", cols("甲乙玄黄"));
  q = await api("GET", `/texts/${text.id}/collation`);
  assert.notEqual(q.body.data.baseVersionId, undefined);
  assert.equal(q.body.data.baseText, "甲乙丙丁"); // 锁定保留
  assert.equal(q.body.data.locks.length, 1);
  assert.equal(q.body.data.locks[0].applied, true);
  assert.equal(q.body.data.locks[0].chars, "丙丁");

  // 解锁后重算，底本恢复为多数版本用字
  const lockId = lock.body.data.id;
  const del = await api("DELETE", `/texts/${text.id}/locks/${lockId}`);
  assert.equal(del.status, 200);
  q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.body.data.baseText, "甲乙玄黄");
});

test("锁定区间越界/重叠 → 拒绝", async () => {
  const text = await makeText();
  await addVersion(text.id, "v1", cols("甲乙丙丁"));
  let r = await api("POST", `/texts/${text.id}/locks`, { start: 3, end: 9 });
  assert.equal(r.status, 400);
  r = await api("POST", `/texts/${text.id}/locks`, { start: 1, end: 3 });
  assert.equal(r.status, 201);
  r = await api("POST", `/texts/${text.id}/locks`, { start: 2, end: 4 });
  assert.equal(r.status, 409);
});

test("回滚：恢复上一份校勘结果，历史为空则 409", async () => {
  const text = await makeText();
  const v1 = (await addVersion(text.id, "v1", cols("天地玄黄"))).body.data;
  await addVersion(text.id, "v2", cols("天地玄文"));
  await addVersion(text.id, "v3", cols("天地玄文"));

  let q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.body.data.baseText, "天地玄文"); // 多数派成为底本

  let rb = await api("POST", `/texts/${text.id}/rollback`);
  assert.equal(rb.status, 200);
  assert.equal(rb.body.data.baseText, "天地玄黄");
  assert.equal(rb.body.data.baseVersionId, v1.id);

  rb = await api("POST", `/texts/${text.id}/rollback`);
  assert.equal(rb.status, 200);
  rb = await api("POST", `/texts/${text.id}/rollback`);
  assert.equal(rb.status, 409); // 历史耗尽
});

test("并发登记不丢版本", async () => {
  const text = await makeText();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => addVersion(text.id, `c${i + 1}`, cols(`字${i + 1}`)))
  );
  for (const r of results) assert.equal(r.status, 201);

  const list = await api("GET", `/texts/${text.id}/versions`);
  assert.equal(list.body.data.length, 8);
  const codes = list.body.data.map((v) => v.code).sort();
  assert.deepEqual(codes, ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);

  const q = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(q.body.data.versions.length, 8);
});

test("重算断点续跑：暂停不污染旧结果，中断后可续跑完成", async () => {
  const text = await makeText();
  await addVersion(text.id, "v1", cols("天地玄黄"));
  await addVersion(text.id, "v2", cols("天地玄文"));
  await addVersion(text.id, "v3", cols("天地玄黄"));

  const before = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(before.status, 200);

  // 3 个版本共 6 对，预算 2 → 暂停在游标 2
  const start = await api("POST", `/texts/${text.id}/recompute`, { pairBudget: 2 });
  assert.equal(start.status, 202);
  const job = start.body.data;
  assert.equal(job.status, "running");
  assert.equal(job.cursor, 2);
  assert.equal(job.pairs.length, 6);

  // 暂停期间查询仍返回上一份完整结果
  const during = await api("GET", `/texts/${text.id}/collation`);
  assert.equal(during.status, 200);
  assert.equal(during.body.data.computedAt, before.body.data.computedAt);

  // 模拟进程中断：任务被标记为 interrupted
  await store.withLock(async (db) => {
    const j = db.jobs.find((x) => x.id === job.id);
    j.status = "interrupted";
    await store.persist();
  });
  const jobQ = await api("GET", `/jobs/${job.id}`);
  assert.equal(jobQ.body.data.status, "interrupted");

  // 续跑至完成
  const resumed = await api("POST", `/jobs/${job.id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.status, "done");
  assert.equal(resumed.body.data.cursor, 6);
  assert.equal(resumed.body.collation.baseText, "天地玄黄");
});
