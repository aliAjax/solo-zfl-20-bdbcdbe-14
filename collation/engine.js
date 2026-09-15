"use strict";

/**
 * 校勘引擎：异体归并、版本字流、代价矩阵、底本选择、锁定应用、结果组装。
 * 全部为纯函数，不触碰存储。
 */

const { CHAR, GAP, charToken, gapToken, alignDetailed } = require("./align");

/** 标准字映射表：异体字 -> 标准字（标准字自身也映射到自身）。 */
function buildVariantMap(groups) {
  const map = {};
  for (const g of groups || []) {
    map[g.standard] = g.standard;
    for (const m of g.members || []) map[m] = g.standard;
  }
  return map;
}

/**
 * 校验一批异体组。规则：
 *  - 每组必须恰好一个标准字（单字，不能为 0 字或多字）；
 *  - 成员必须是非空单字数组；
 *  - 同一个字（无论作为标准字还是成员）不得出现在两个组中。
 * 返回冲突列表；空数组/ null 表示通过。调用方负责“冲突整批拒绝”。
 */
function validateVariantGroups(groups) {
  const conflicts = [];
  const usage = new Map(); // 字 -> 组序号
  groups.forEach((g, gi) => {
    const stdChars = g && typeof g.standard === "string" ? [...g.standard] : [];
    if (stdChars.length !== 1) {
      conflicts.push({ group: gi, reason: "每组必须恰好一个单字标准字" });
      return;
    }
    if (!Array.isArray(g.members) || g.members.length === 0) {
      conflicts.push({ group: gi, reason: "异体成员必须是非空数组" });
      return;
    }
    const members = [];
    for (const m of g.members) {
      const chars = typeof m === "string" ? [...m] : [];
      if (chars.length !== 1) {
        conflicts.push({ group: gi, reason: `成员「${m}」必须是单字` });
        continue;
      }
      members.push(chars[0]);
    }
    for (const c of new Set([stdChars[0], ...members])) {
      if (usage.has(c)) {
        conflicts.push({ group: gi, char: c, reason: `字「${c}」与第 ${usage.get(c)} 组冲突（一字只能属于一个异体组）` });
      } else {
        usage.set(c, gi);
      }
    }
  });
  return conflicts.length ? conflicts : null;
}

/** 版本字流：按列号升序展开；缺页列折叠为缺页标记；字按异体表归并。 */
function versionTokens(version, vmap) {
  const tokens = [];
  const cols = [...(version.columns || [])].sort((a, b) => a.no - b.no);
  for (const col of cols) {
    if (col.missingPage) {
      if (!tokens.length || tokens[tokens.length - 1].kind !== GAP) tokens.push(gapToken());
      continue;
    }
    for (const ch of String(col.chars || "")) {
      tokens.push(charToken(ch, vmap[ch] || ch));
    }
  }
  return tokens;
}

/** 字流中的实字（标准字序列，候选底本用）。 */
function tokenChars(tokens) {
  return tokens.filter((t) => t.kind === CHAR).map((t) => t.norm);
}

/** 代价矩阵需要的无序版本对：[版本A, 版本B]（每对只算一次，双向取小）。 */
function computePairs(versions) {
  const pairs = [];
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      pairs.push([versions[i].id, versions[j].id]);
    }
  }
  return pairs;
}

/** 一对版本的对称代价：正反两向对齐，取较小者（正反一致由构造保证）。 */
function pairCost(tokensA, charsA, tokensB, charsB) {
  const ab = alignDetailed(charsA, tokensB).cost;
  const ba = alignDetailed(charsB, tokensA).cost;
  return Math.min(ab, ba);
}

/**
 * 底本选择：总编辑代价最小；同分先早登记（seq 小），再按版本编号 code，最后按内部 id。
 * 不含实字的版本（整本缺页）不作底本候选，除非所有版本都缺页。
 */
function selectBase(versions, totals, eligibleIds) {
  let pool = eligibleIds ? versions.filter((v) => eligibleIds.has(v.id)) : versions;
  if (!pool.length) pool = versions;
  const sorted = [...pool].sort((a, b) => {
    const d = (totals[a.id] || 0) - (totals[b.id] || 0);
    if (d !== 0) return d;
    if (a.seq !== b.seq) return a.seq - b.seq;
    const c = String(a.code).localeCompare(String(b.code), "zh-Hans-CN");
    if (c !== 0) return c;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted[0] || null;
}

/**
 * 组装校勘结果。
 * text: 文本记录（含 revision）；versions: 当前全部版本；
 * groups: 异体组；locks: 人工锁定段；costMatrix: 已算好的两两代价；
 * now: 计算完成时间戳（由调用方提供，保证可测）。
 */
function finalizeResult({ text, versions, groups, locks, costMatrix, now }) {
  const vmap = buildVariantMap(groups);
  const tokensByV = {};
  const charsByV = {};
  for (const v of versions) {
    const t = versionTokens(v, vmap);
    tokensByV[v.id] = t;
    charsByV[v.id] = tokenChars(t);
  }

  if (versions.length === 0) {
    return {
      textId: text.id,
      revision: text.revision,
      baseVersionId: null,
      baseText: "",
      baseLength: 0,
      costs: {},
      matrix: {},
      columns: [],
      versions: [],
      locks: [],
      computedAt: now
    };
  }

  const totals = {};
  for (const v of versions) {
    let total = 0;
    for (const o of versions) {
      if (o.id === v.id) continue;
      const cached = costMatrix && costMatrix[v.id] && costMatrix[v.id][o.id];
      total += cached !== undefined ? cached : pairCost(tokensByV[v.id], charsByV[v.id], tokensByV[o.id], charsByV[o.id]);
    }
    totals[v.id] = total;
  }

  // 底本候选须含实字（整本缺页不作底本，除非全部如此）
  const eligible = new Set(versions.filter((v) => charsByV[v.id].length > 0).map((v) => v.id));
  const base = selectBase(versions, totals, eligible);

  // 应用人工锁定：锁定段按绝对位置钉在底本上，重算不移动。
  const baseChars = [...charsByV[base.id]];
  const locksApplied = [];
  for (const lock of [...(locks || [])].sort((a, b) => a.start - b.start)) {
    const applied = lock.end <= baseChars.length;
    if (applied) {
      baseChars.splice(lock.start, lock.end - lock.start, ...lock.chars);
    }
    locksApplied.push({
      id: lock.id,
      start: lock.start,
      end: lock.end,
      chars: lock.chars.join(""),
      note: lock.note || "",
      applied
    });
  }

  const columns = baseChars.map((ch, pos) => ({ pos, char: ch, support: [] }));
  const versionReports = [];
  for (const v of [...versions].sort((a, b) => a.seq - b.seq)) {
    const r = alignDetailed(baseChars, tokensByV[v.id]);
    let supports = 0;
    r.columns.forEach((c, idx) => {
      if (c && c.op === "match") {
        columns[idx].support.push(v.id);
        supports++;
      }
    });
    versionReports.push({
      id: v.id,
      code: v.code,
      seq: v.seq,
      cost: r.cost,
      supports,
      stats: r.stats,
      diff: r.ops
    });
  }

  return {
    textId: text.id,
    revision: text.revision,
    baseVersionId: base.id,
    baseText: baseChars.join(""),
    baseLength: baseChars.length,
    costs: totals,
    matrix: costMatrix || {},
    columns,
    versions: versionReports,
    locks: locksApplied,
    computedAt: now
  };
}

module.exports = {
  buildVariantMap,
  validateVariantGroups,
  versionTokens,
  tokenChars,
  computePairs,
  pairCost,
  selectBase,
  finalizeResult
};
