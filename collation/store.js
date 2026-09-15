"use strict";

/**
 * 存储层：单文件 JSON 持久化 + 进程内互斥锁。
 *  - 所有写操作经 withLock 串行化，并发登记不会丢版本；
 *  - 落盘采用 临时文件 + rename，避免半截文件。
 */

const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");

let db = null;
let dbFile = null;
let queue = Promise.resolve();

function seed() {
  return {
    texts: [],
    versions: [],
    variants: {}, // textId -> [ { id, standard, members } ]
    locks: [],
    results: {}, // textId -> 最新校勘结果
    history: {}, // textId -> [ 历史结果 ]（供回滚，最多 10 条）
    jobs: []
  };
}

async function init(file) {
  dbFile = file;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    db = JSON.parse(await readFile(file, "utf8"));
  } catch {
    db = seed();
    await persist();
  }
  const shape = seed();
  for (const k of Object.keys(shape)) {
    if (!(k in db)) db[k] = shape[k];
  }
  return db;
}

function getDb() {
  if (!db) throw new Error("store 未初始化");
  return db;
}

async function persist() {
  const tmp = `${dbFile}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbFile);
}

/** 串行执行变更；fn 接收当前 db，返回值为调用方结果。 */
function withLock(fn) {
  const run = queue.then(() => fn(db));
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { init, getDb, persist, withLock };
