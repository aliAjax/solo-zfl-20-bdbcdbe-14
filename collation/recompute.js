"use strict";

/**
 * 重算调度：
 *  - 每个文本的重算串行执行（recomputeChains），并发登记只排队、不丢版本；
 *  - 代价矩阵按对（pair）计算并落盘，进程中断后可从游标处续跑；
 *  - 结果在 finalize 时一次性原子发布，中断期间查询仍返回上一份完整结果；
 *  - 启动时把 running 任务标记为 interrupted，并补齐过期文本的重算。
 */

const store = require("./store");
const {
  buildVariantMap,
  versionTokens,
  tokenChars,
  computePairs,
  finalizeResult
} = require("./engine");
const { alignDetailed } = require("./align");

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const recomputeChains = new Map();

/** 创建或复用当前修订的重算任务；过期的未完成任务标记为 superseded。 */
async function ensureJob(textId) {
  return store.withLock(async (db) => {
    const text = db.texts.find((t) => t.id === textId);
    if (!text) {
      const e = new Error("校勘文本不存在");
      e.status = 404;
      throw e;
    }
    let job = null;
    for (const j of db.jobs) {
      if (j.textId !== textId || j.status === "done" || j.status === "superseded") continue;
      if (j.revision === text.revision && !job) {
        job = j;
      } else {
        j.status = "superseded";
        j.updatedAt = now();
      }
    }
    if (!job) {
      const versions = db.versions.filter((v) => v.textId === textId);
      job = {
        id: makeId("job"),
        textId,
        revision: text.revision,
        status: "running",
        pairs: computePairs(versions),
        cursor: 0,
        costMatrix: {},
        createdAt: now(),
        updatedAt: now(),
        finishedAt: null
      };
      db.jobs.push(job);
    }
    await store.persist();
    return job;
  });
}

/**
 * 执行一个任务：按 pairBudget 处理若干对后落盘（断点），
 * 全部完成后在锁内原子发布结果（旧结果进入历史，供回滚）。
 */
async function runJob(jobId, { pairBudget = Infinity } = {}) {
  const snap = await store.withLock(async (db) => {
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) {
      const e = new Error("重算任务不存在");
      e.status = 404;
      throw e;
    }
    if (job.status === "done") return { done: true, job };
    if (job.status === "superseded") {
      const e = new Error("任务已被更新的登记取代，请重新触发重算");
      e.status = 409;
      throw e;
    }
    const text = db.texts.find((t) => t.id === job.textId);
    if (job.revision !== text.revision) {
      // 任务过期：按当前版本集重置游标与矩阵
      const versions = db.versions.filter((v) => v.textId === job.textId);
      job.pairs = computePairs(versions);
      job.cursor = 0;
      job.costMatrix = {};
      job.revision = text.revision;
    }
    job.status = "running";
    job.updatedAt = now();
    await store.persist();
    return {
      done: false,
      job: JSON.parse(JSON.stringify(job)),
      versions: db.versions.filter((v) => v.textId === job.textId),
      groups: db.variants[job.textId] || []
    };
  });
  if (snap.done) return snap.job;

  const { job, versions, groups } = snap;
  const vmap = buildVariantMap(groups);
  const tokensByV = {};
  const charsByV = {};
  for (const v of versions) {
    const t = versionTokens(v, vmap);
    tokensByV[v.id] = t;
    charsByV[v.id] = tokenChars(t);
  }

  let budget = pairBudget;
  while (job.cursor < job.pairs.length && budget > 0) {
    const [bId, vId] = job.pairs[job.cursor];
    const cost = alignDetailed(charsByV[bId] || [], tokensByV[vId] || []).cost;
    (job.costMatrix[bId] = job.costMatrix[bId] || {})[vId] = cost;
    job.cursor++;
    budget--;
  }
  job.updatedAt = now();
  const finished = job.cursor >= job.pairs.length;

  return store.withLock(async (db) => {
    const live = db.jobs.find((j) => j.id === jobId);
    if (!live) {
      const e = new Error("重算任务不存在");
      e.status = 404;
      throw e;
    }
    const text = db.texts.find((t) => t.id === live.textId);
    if (live.revision !== text.revision) {
      // 计算期间又有新登记：本次进度作废，回到游标起点按新修订重算
      const vs = db.versions.filter((v) => v.textId === live.textId);
      live.pairs = computePairs(vs);
      live.cursor = 0;
      live.costMatrix = {};
      live.revision = text.revision;
      live.status = "running";
      live.updatedAt = now();
      await store.persist();
      return live;
    }
    live.cursor = job.cursor;
    live.costMatrix = job.costMatrix;
    live.updatedAt = job.updatedAt;
    if (!finished) {
      live.status = "running";
      await store.persist();
      return live;
    }
    const finalVersions = db.versions.filter((v) => v.textId === live.textId);
    const locks = db.locks.filter((l) => l.textId === live.textId);
    const finalGroups = db.variants[live.textId] || [];
    const result = finalizeResult({
      text,
      versions: finalVersions,
      groups: finalGroups,
      locks,
      costMatrix: live.costMatrix,
      now: now()
    });
    if (db.results[live.textId]) {
      (db.history[live.textId] = db.history[live.textId] || []).push(db.results[live.textId]);
      if (db.history[live.textId].length > 10) db.history[live.textId].shift();
    }
    db.results[live.textId] = result;
    live.status = "done";
    live.finishedAt = now();
    await store.persist();
    return live;
  });
}

async function recomputeLoop(textId, { pairBudget = Infinity } = {}) {
  let lastJob = null;
  for (let iter = 0; iter < 20; iter++) {
    const job = await ensureJob(textId);
    lastJob = await runJob(job.id, { pairBudget });
    if (lastJob.status !== "done") return lastJob; // 预算用尽，暂停待续跑
    const db = store.getDb();
    const text = db.texts.find((t) => t.id === textId);
    const result = db.results[textId];
    if (result && text && result.revision === text.revision) return lastJob;
    // 计算期间又有变更，继续下一轮直至结果最新
  }
  return lastJob;
}

/**
 * 触发重算（按文本串行）。
 * force=false 时若结果已最新则跳过；pairBudget 用于断点续跑演示/测试。
 */
function recomputeText(textId, { pairBudget = Infinity, force = false } = {}) {
  const prev = recomputeChains.get(textId) || Promise.resolve();
  const next = prev.then(async () => {
    if (!force) {
      const db = store.getDb();
      const text = db.texts.find((t) => t.id === textId);
      const result = db.results[textId];
      if (text && result && result.revision === text.revision) return null;
    }
    return recomputeLoop(textId, { pairBudget });
  });
  recomputeChains.set(
    textId,
    next.catch(() => undefined)
  );
  return next;
}

/** 续跑指定任务（供中断恢复 / 手动续跑）。 */
function resumeJob(jobId, { pairBudget = Infinity } = {}) {
  const db = store.getDb();
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job) {
    const e = new Error("重算任务不存在");
    e.status = 404;
    throw e;
  }
  const prev = recomputeChains.get(job.textId) || Promise.resolve();
  const next = prev.then(() => runJob(jobId, { pairBudget }));
  recomputeChains.set(
    job.textId,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * 启动恢复：
 *  1. 上次进程退出时仍在 running 的任务标记为 interrupted（可续跑）；
 *  2. 结果落后于当前修订的文本立即补算（优先续跑断点任务）。
 */
async function recover() {
  await store.withLock(async (db) => {
    let changed = false;
    for (const j of db.jobs) {
      if (j.status === "running") {
        j.status = "interrupted";
        j.updatedAt = now();
        changed = true;
      }
    }
    if (changed) await store.persist();
  });
  const db = store.getDb();
  for (const text of db.texts) {
    const result = db.results[text.id];
    if (result && result.revision === text.revision) continue;
    const job = db.jobs.find(
      (j) => j.textId === text.id && j.status === "interrupted" && j.revision === text.revision
    );
    if (job) {
      await resumeJob(job.id);
    } else {
      await recomputeText(text.id);
    }
  }
}

module.exports = { recomputeText, runJob, resumeJob, recover, ensureJob };
