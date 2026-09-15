"use strict";

/**
 * 拓片多版本校勘服务（零依赖）。
 * 启动：PORT=3030 node collation/server.js
 * 数据：data/collation.json（可用 COLLATION_DB 覆盖）
 */

const http = require("http");
const path = require("path");

const store = require("./store");
const { validateVariantGroups } = require("./engine");
const { recomputeText, resumeJob, recover } = require("./recompute");

const DEFAULT_PORT = 3030;

const routes = [
  "GET /health",
  "GET /texts",
  "POST /texts",
  "GET /texts/:id",
  "GET /texts/:id/versions",
  "POST /texts/:id/versions",
  "DELETE /texts/:id/versions/:vid",
  "GET /texts/:id/variants",
  "PUT /texts/:id/variants",
  "GET /texts/:id/locks",
  "POST /texts/:id/locks",
  "DELETE /texts/:id/locks/:lid",
  "GET /texts/:id/collation",
  "POST /texts/:id/recompute",
  "POST /texts/:id/rollback",
  "GET /jobs/:id",
  "POST /jobs/:id/resume"
];

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function fail(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  throw error;
}

function findText(db, textId) {
  const text = db.texts.find((t) => t.id === textId);
  if (!text) fail(404, "校勘文本不存在");
  return text;
}

function summarize(result) {
  if (!result) return null;
  return {
    revision: result.revision,
    baseVersionId: result.baseVersionId,
    baseText: result.baseText,
    costs: result.costs,
    computedAt: result.computedAt
  };
}

/** 校验并规范化列登记：列号唯一、缺页列不得带字、按列号升序。 */
function normalizeColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(400, "columns 必须是非空数组");
  }
  const seen = new Set();
  const out = columns.map((col, idx) => {
    const no = col && col.no;
    if (!Number.isInteger(no)) fail(400, `第 ${idx} 列缺少整数列号 no`);
    if (seen.has(no)) fail(400, `列号重复：${no}`);
    seen.add(no);
    const missingPage = Boolean(col.missingPage);
    const chars = typeof col.chars === "string" ? col.chars : "";
    if (missingPage && chars.length > 0) fail(400, `第 ${no} 列标记为缺页，不应登记字`);
    return { no, chars, missingPage };
  });
  out.sort((a, b) => a.no - b.no);
  return out;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-collation-api", routes });
  }

  // ---------- 文本 ----------
  if (req.method === "GET" && pathname === "/texts") {
    const db = store.getDb();
    const data = db.texts.map((t) => {
      const result = db.results[t.id];
      return {
        ...t,
        versionCount: db.versions.filter((v) => v.textId === t.id).length,
        baseVersionId: result ? result.baseVersionId : null,
        baseText: result ? result.baseText : "",
        computedAt: result ? result.computedAt : null
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/texts") {
    const body = await parseBody(req);
    if (!body.title || typeof body.title !== "string") fail(400, "缺少字段：title");
    const text = await store.withLock(async (db) => {
      const t = {
        id: makeId("text"),
        title: body.title,
        note: body.note || "",
        revision: 0,
        nextSeq: 1,
        createdAt: now()
      };
      db.texts.push(t);
      await store.persist();
      return t;
    });
    return send(res, 201, { data: text });
  }

  const textMatch = pathname.match(/^\/texts\/([^/]+)$/);
  if (textMatch && req.method === "GET") {
    const db = store.getDb();
    const text = findText(db, textMatch[1]);
    const result = db.results[text.id];
    return send(res, 200, {
      data: {
        ...text,
        versionCount: db.versions.filter((v) => v.textId === text.id).length,
        collation: summarize(result)
      }
    });
  }

  // ---------- 版本登记 ----------
  const versionsMatch = pathname.match(/^\/texts\/([^/]+)\/versions$/);
  if (versionsMatch && req.method === "GET") {
    const db = store.getDb();
    findText(db, versionsMatch[1]);
    const data = db.versions
      .filter((v) => v.textId === versionsMatch[1])
      .sort((a, b) => a.seq - b.seq);
    return send(res, 200, { data });
  }

  if (versionsMatch && req.method === "POST") {
    const textId = versionsMatch[1];
    const body = await parseBody(req);
    if (!body.code || typeof body.code !== "string") fail(400, "缺少字段：code");
    const columns = normalizeColumns(body.columns);
    const outcome = await store.withLock(async (db) => {
      const text = findText(db, textId);
      if (body.requestId) {
        const dup = db.versions.find((v) => v.textId === textId && v.requestId === body.requestId);
        if (dup) return { duplicated: true, version: dup };
      }
      if (db.versions.some((v) => v.textId === textId && v.code === body.code)) {
        fail(409, `版本编号已存在：${body.code}`);
      }
      const version = {
        id: makeId("ver"),
        textId,
        code: body.code,
        requestId: body.requestId || null,
        seq: text.nextSeq++,
        columns,
        note: body.note || "",
        createdAt: now()
      };
      text.revision++;
      db.versions.push(version);
      await store.persist();
      return { duplicated: false, version };
    });
    if (outcome.duplicated) {
      return send(res, 200, { data: outcome.version, duplicated: true });
    }
    // 新增版本后立即重算，响应即最新结果
    await recomputeText(textId);
    const collation = summarize(store.getDb().results[textId]);
    return send(res, 201, { data: outcome.version, collation });
  }

  const versionDeleteMatch = pathname.match(/^\/texts\/([^/]+)\/versions\/([^/]+)$/);
  if (versionDeleteMatch && req.method === "DELETE") {
    const [textId, vid] = [versionDeleteMatch[1], versionDeleteMatch[2]];
    await store.withLock(async (db) => {
      const text = findText(db, textId);
      const idx = db.versions.findIndex((v) => v.id === vid && v.textId === textId);
      if (idx === -1) fail(404, "版本不存在");
      db.versions.splice(idx, 1);
      text.revision++;
      await store.persist();
    });
    await recomputeText(textId);
    return send(res, 200, { deleted: vid, collation: summarize(store.getDb().results[textId]) });
  }

  // ---------- 异体字组 ----------
  const variantsMatch = pathname.match(/^\/texts\/([^/]+)\/variants$/);
  if (variantsMatch && req.method === "GET") {
    const db = store.getDb();
    findText(db, variantsMatch[1]);
    return send(res, 200, { data: db.variants[variantsMatch[1]] || [] });
  }

  if (variantsMatch && req.method === "PUT") {
    const textId = variantsMatch[1];
    const body = await parseBody(req);
    if (!Array.isArray(body.groups)) fail(400, "groups 必须是数组");
    const conflicts = validateVariantGroups(body.groups);
    if (conflicts) {
      // 冲突整批拒绝：不写任何状态
      return send(res, 409, { error: "异体组冲突，整批已拒绝", conflicts });
    }
    const groups = await store.withLock(async (db) => {
      const text = findText(db, textId);
      const normalized = body.groups.map((g, i) => ({
        id: `vg_${i + 1}`,
        standard: [...g.standard][0],
        members: [...new Set(g.members.map((m) => [...m][0]))]
      }));
      db.variants[textId] = normalized;
      text.revision++;
      await store.persist();
      return normalized;
    });
    await recomputeText(textId);
    return send(res, 200, { data: groups, collation: summarize(store.getDb().results[textId]) });
  }

  // ---------- 人工锁定 ----------
  const locksMatch = pathname.match(/^\/texts\/([^/]+)\/locks$/);
  if (locksMatch && req.method === "GET") {
    const db = store.getDb();
    findText(db, locksMatch[1]);
    const data = db.locks
      .filter((l) => l.textId === locksMatch[1])
      .map((l) => ({ ...l, chars: l.chars.join("") }));
    return send(res, 200, { data });
  }

  if (locksMatch && req.method === "POST") {
    const textId = locksMatch[1];
    const body = await parseBody(req);
    const { start, end } = body;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      fail(400, "start/end 必须是整数且 0 <= start < end");
    }
    const lock = await store.withLock(async (db) => {
      const text = findText(db, textId);
      const result = db.results[textId];
      if (!result) fail(409, "暂无校勘结果，无法锁定段落");
      if (end > result.baseLength) fail(400, `锁定区间超出底本长度 ${result.baseLength}`);
      const overlap = db.locks.some(
        (l) => l.textId === textId && !(end <= l.start || start >= l.end)
      );
      if (overlap) fail(409, "锁定段与已有锁定重叠");
      const chars = [...result.baseText].slice(start, end);
      const item = {
        id: makeId("lock"),
        textId,
        start,
        end,
        chars,
        note: body.note || "",
        createdAt: now()
      };
      db.locks.push(item);
      text.revision++;
      await store.persist();
      return item;
    });
    await recomputeText(textId);
    return send(res, 201, {
      data: { ...lock, chars: lock.chars.join("") },
      collation: summarize(store.getDb().results[textId])
    });
  }

  const lockDeleteMatch = pathname.match(/^\/texts\/([^/]+)\/locks\/([^/]+)$/);
  if (lockDeleteMatch && req.method === "DELETE") {
    const [textId, lid] = [lockDeleteMatch[1], lockDeleteMatch[2]];
    await store.withLock(async (db) => {
      const text = findText(db, textId);
      const idx = db.locks.findIndex((l) => l.id === lid && l.textId === textId);
      if (idx === -1) fail(404, "锁定段不存在");
      db.locks.splice(idx, 1);
      text.revision++;
      await store.persist();
    });
    await recomputeText(textId);
    return send(res, 200, { deleted: lid, collation: summarize(store.getDb().results[textId]) });
  }

  // ---------- 校勘查询 ----------
  const collationMatch = pathname.match(/^\/texts\/([^/]+)\/collation$/);
  if (collationMatch && req.method === "GET") {
    const db = store.getDb();
    findText(db, collationMatch[1]);
    const result = db.results[collationMatch[1]];
    if (!result) return send(res, 404, { error: "校勘结果尚未生成" });
    return send(res, 200, { data: result });
  }

  // ---------- 重算（支持断点续跑） ----------
  const recomputeMatch = pathname.match(/^\/texts\/([^/]+)\/recompute$/);
  if (recomputeMatch && req.method === "POST") {
    const textId = recomputeMatch[1];
    const body = await parseBody(req);
    const pairBudget = Number.isInteger(body.pairBudget) && body.pairBudget > 0 ? body.pairBudget : Infinity;
    const job = await recomputeText(textId, { pairBudget, force: true });
    const collation = summarize(store.getDb().results[textId]);
    if (job && job.status !== "done") {
      return send(res, 202, { data: job, hint: "任务未完成，可 POST /jobs/:id/resume 续跑" });
    }
    return send(res, 200, { data: job, collation });
  }

  // ---------- 回滚 ----------
  const rollbackMatch = pathname.match(/^\/texts\/([^/]+)\/rollback$/);
  if (rollbackMatch && req.method === "POST") {
    const textId = rollbackMatch[1];
    const result = await store.withLock(async (db) => {
      const text = findText(db, textId);
      const hist = db.history[textId] || [];
      if (!hist.length) fail(409, "没有可回滚的历史结果");
      const prev = hist.pop();
      db.results[textId] = prev;
      text.revision = prev.revision; // 防止启动恢复把回滚结果误判为过期
      await store.persist();
      return prev;
    });
    return send(res, 200, { data: summarize(result) });
  }

  // ---------- 任务 ----------
  const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const db = store.getDb();
    const job = db.jobs.find((j) => j.id === jobMatch[1]);
    if (!job) return send(res, 404, { error: "重算任务不存在" });
    return send(res, 200, { data: job });
  }

  const resumeMatch = pathname.match(/^\/jobs\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const pairBudget = Number.isInteger(body.pairBudget) && body.pairBudget > 0 ? body.pairBudget : Infinity;
    const job = await resumeJob(resumeMatch[1], { pairBudget });
    const textId = job.textId;
    const collation = summarize(store.getDb().results[textId]);
    if (job.status !== "done") {
      return send(res, 202, { data: job, hint: "任务未完成，可再次 resume 续跑" });
    }
    return send(res, 200, { data: job, collation });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      send(res, error.status || 500, {
        error: error.message || "服务器错误",
        ...(error.extra ? { extra: error.extra } : {})
      });
    });
  });
}

async function main() {
  const dbFile = process.env.COLLATION_DB || path.join(__dirname, "..", "data", "collation.json");
  await store.init(dbFile);
  const recovered = await recover();
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createServer();
  server.listen(port, () => {
    console.log(`Rubbing collation API running at http://127.0.0.1:${port}`);
    console.log(`DB: ${dbFile}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer, main };
