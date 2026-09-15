"use strict";

/**
 * 对齐引擎（第二版）：LCS 锚点 + 移动块识别。
 *
 * 字流模型：
 *  - 普通字：{ kind: "char", raw: 原字, norm: 归并后的标准字 }
 *  - 缺页标记：{ kind: "gap" }，连续缺页列合并为一个边界；
 *    落在缺页区域的底本字记 missing_page，代价为 0（缺页不计缺字）。
 *
 * 对齐流程（确定性的）：
 *  1. 版本字流拆出实字与缺页边界；
 *  2. LCS 求锚点（两序列中相对顺序不变的公共字），前向贪心回溯，结果确定；
 *  3. 非锚点内容：底本侧为缺失块，版本侧为插入块（缺页边界会切断插入块，
 *     使移动块不会横跨缺页）；
 *  4. 换位识别：内容完全相同的缺失块与插入块配成一次换位——不限块长、
 *     不限距离；候选按（块长降序、位置升序）排序后贪心选配，每块只用一次，
 *     重复字与交叉移动因此也有确定结果；
 *  5. 剩余块按“区域”（相邻锚点之间）结算：
 *     - 同区缺失块+插入块 → 逐字替换，多出部分成一段插入/缺失；
 *     - 含缺页边界的区域 → 底本字记 missing_page（0），版本字记一段插入。
 *
 * 计权规则（段级）：
 *  - 替换：每字 1
 *  - 插入 / 缺失：每个连续段 1（段内长度不计）
 *  - 换位：每处 1（任意连续块只移动一次都按一次计）
 *  - 缺页：0
 */

const CHAR = "char";
const GAP = "gap";

function charToken(raw, norm) {
  return { kind: CHAR, raw, norm };
}

function gapToken() {
  return { kind: GAP };
}

/** LCS 长度表（后缀 DP）。 */
function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * LCS 锚点：前向贪心回溯（能配则配、否则先推进底本侧），
 * 同一输入永远得到同一锚点序列。返回 [[底本下标, 版本下标], ...]。
 */
function lcsAnchors(a, b) {
  const dp = lcsTable(a, b);
  const anchors = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (dp[i][j] === dp[i + 1][j]) {
      i++;
    } else {
      j++;
    }
  }
  return anchors;
}

/** 段级计权。 */
function scoreOps(ops) {
  const stats = {
    substitute: 0,
    insert: 0,
    insertChars: 0,
    missing: 0,
    missingChars: 0,
    missingPage: 0,
    missingPageChars: 0,
    transposition: 0,
    cost: 0
  };
  for (const op of ops) {
    if (op.type === "substitute") {
      stats.substitute++;
      stats.cost++;
    } else if (op.type === "insert") {
      stats.insert++;
      stats.insertChars += op.chars.length;
      stats.cost++;
    } else if (op.type === "missing") {
      stats.missing++;
      stats.missingChars += op.chars.length;
      stats.cost++;
    } else if (op.type === "missing_page") {
      stats.missingPage++;
      stats.missingPageChars += op.chars.length;
    } else if (op.type === "transposition") {
      stats.transposition++;
      stats.cost++;
    }
  }
  return stats;
}

/**
 * 由给定锚点序列构建对齐结果。
 * B：底本标准字数组；vToks：版本侧实字 token；V：其标准字；
 * gapBefore：缺页边界集合；anchors：[[底本下标, 版本下标], ...]（递增）；
 * allowMoves：是否进行换位配对（调用方会比较两种结果取代价低者）。
 */
function alignWithAnchors(B, vToks, V, gapBefore, anchors, allowMoves) {
  const anchorB = new Set(anchors.map(([bi]) => bi));
  const anchorV = new Set(anchors.map(([, vi]) => vi));
  const anchorBList = anchors.map(([bi]) => bi);
  const anchorVList = anchors.map(([, vi]) => vi);
  const regionOf = (idx, anchorIdxs) => {
    let r = 0;
    for (const a of anchorIdxs) {
      if (a < idx) r++;
      else break;
    }
    return r;
  };

  // 3. 缺失块（底本侧非锚点连续段）
  const dChunks = [];
  {
    let cur = null;
    for (let i = 0; i < B.length; i++) {
      if (anchorB.has(i)) {
        cur = null;
        continue;
      }
      if (!cur) {
        cur = { start: i, chars: [], region: regionOf(i, anchorBList) };
        dChunks.push(cur);
      }
      cur.chars.push(B[i]);
    }
  }
  // 插入块（版本侧非锚点连续段，缺页边界切断——移动块不得横跨缺页）
  const iChunks = [];
  {
    let cur = null;
    for (let j = 0; j < V.length; j++) {
      if (anchorV.has(j)) {
        cur = null;
        continue;
      }
      if (!cur || gapBefore.has(j)) {
        cur = { start: j, chars: [], raws: [], region: regionOf(j, anchorVList) };
        iChunks.push(cur);
      }
      cur.chars.push(V[j]);
      cur.raws.push(vToks[j].raw);
    }
  }
  // 含缺页边界的区域
  const gapRegions = new Set();
  for (const k of gapBefore) gapRegions.add(regionOf(k, anchorVList));

  // 4. 换位配对：缺失块与插入块的公共连续子块（极大），不限长度与距离；
  //    候选按（块长降序、底本位置、版本位置）排序后贪心选配，各位点只用一次。
  //    相邻的多个移动块（如交叉移动）因此能拆成多次换位，重复字也有确定结果。
  //    allowMoves 为假时跳过配对（调用方比较含/不含换位两种结果取代价低者）。
  const candidates = [];
  if (allowMoves) {
    for (let di = 0; di < dChunks.length; di++) {
      for (let ii = 0; ii < iChunks.length; ii++) {
        const d = dChunks[di];
        const ic = iChunks[ii];
        for (let s = 0; s < d.chars.length; s++) {
          for (let t = 0; t < ic.chars.length; t++) {
            if (d.chars[s] !== ic.chars[t]) continue;
            if (s > 0 && t > 0 && d.chars[s - 1] === ic.chars[t - 1]) continue; // 非极大起点
            let L = 0;
            while (s + L < d.chars.length && t + L < ic.chars.length && d.chars[s + L] === ic.chars[t + L]) L++;
            candidates.push({ di, ii, dOff: s, iOff: t, len: L, dStart: d.start + s, iStart: ic.start + t });
          }
        }
      }
    }
  }
  candidates.sort((x, y) => y.len - x.len || x.dStart - y.dStart || x.iStart - y.iStart);
  const dUsed = dChunks.map((c) => new Array(c.chars.length).fill(false));
  const iUsed = iChunks.map((c) => new Array(c.chars.length).fill(false));
  const moves = [];
  for (const c of candidates) {
    let free = true;
    for (let k = 0; k < c.len; k++) {
      if (dUsed[c.di][c.dOff + k] || iUsed[c.ii][c.iOff + k]) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    for (let k = 0; k < c.len; k++) {
      dUsed[c.di][c.dOff + k] = true;
      iUsed[c.ii][c.iOff + k] = true;
    }
    moves.push({
      pos: c.dStart,
      chars: dChunks[c.di].chars.slice(c.dOff, c.dOff + c.len),
      movedTo: c.iStart
    });
  }

  // 5. 区域结算：未被换位消费的剩余连续小段
  const dRuns = []; // { positions, chars, region }
  dChunks.forEach((c, di) => {
    let k = 0;
    while (k < c.chars.length) {
      if (dUsed[di][k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < c.chars.length && !dUsed[di][e]) e++;
      const positions = [];
      for (let p = k; p < e; p++) positions.push(c.start + p);
      dRuns.push({ positions, chars: c.chars.slice(k, e), region: c.region });
      k = e;
    }
  });
  const iRuns = []; // { start, chars, raws, region }
  iChunks.forEach((c, ii) => {
    let k = 0;
    while (k < c.chars.length) {
      if (iUsed[ii][k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < c.chars.length && !iUsed[ii][e]) e++;
      iRuns.push({ start: c.start + k, chars: c.chars.slice(k, e), raws: c.raws.slice(k, e), region: c.region });
      k = e;
    }
  });

  const dByRegion = new Map();
  for (const r of dRuns) {
    if (!dByRegion.has(r.region)) dByRegion.set(r.region, []);
    dByRegion.get(r.region).push(r);
  }
  const iByRegion = new Map();
  for (const r of iRuns) {
    if (!iByRegion.has(r.region)) iByRegion.set(r.region, []);
    iByRegion.get(r.region).push(r);
  }
  const allRegions = new Set([...dByRegion.keys(), ...iByRegion.keys(), ...gapRegions]);

  const ops = [];
  const columns = new Array(B.length).fill(null);
  for (const [bi, vi] of anchors) {
    columns[bi] = { op: "match", norm: B[bi], raw: vToks[vi].raw };
  }
  for (const m of moves) {
    ops.push({ type: "transposition", pos: m.pos, baseChars: m.chars, chars: m.chars, movedTo: m.movedTo });
    m.chars.forEach((_, k) => {
      columns[m.pos + k] = { op: "transposition" };
    });
  }
  const regionEndB = (r) => (r < anchors.length ? anchors[r][0] : B.length);

  /** 把一串剩余底本位（含位置）按位置连续性切成 missing/missing_page 段 */
  const emitMissing = (type, positions, chars) => {
    let s = 0;
    while (s < positions.length) {
      let e = s;
      while (e + 1 < positions.length && positions[e + 1] === positions[e] + 1) e++;
      ops.push({ type, pos: positions[s], chars: chars.slice(s, e + 1) });
      for (let k = s; k <= e; k++) columns[positions[k]] = { op: type };
      s = e + 1;
    }
  };

  for (const r of [...allRegions].sort((a, b) => a - b)) {
    const dList = dByRegion.get(r) || [];
    const iList = iByRegion.get(r) || [];
    const dPositions = dList.flatMap((x) => x.positions);
    const dChars = dList.flatMap((x) => x.chars);
    const iChars = iList.flatMap((x) => x.chars);
    const iRaws = iList.flatMap((x) => x.raws);
    if (gapRegions.has(r)) {
      // 缺页区域：底本字记缺页（0 代价），版本实字记一段插入
      if (dPositions.length) emitMissing("missing_page", dPositions, dChars);
      if (iChars.length) ops.push({ type: "insert", at: regionEndB(r), chars: iChars, raws: iRaws });
      continue;
    }
    const L = Math.min(dChars.length, iChars.length);
    for (let k = 0; k < L; k++) {
      ops.push({ type: "substitute", pos: dPositions[k], base: dChars[k], char: iChars[k], raw: iRaws[k] });
      columns[dPositions[k]] = { op: "substitute", norm: iChars[k], raw: iRaws[k] };
    }
    if (dChars.length > L) emitMissing("missing", dPositions.slice(L), dChars.slice(L));
    if (iChars.length > L) ops.push({ type: "insert", at: regionEndB(r), chars: iChars.slice(L), raws: iRaws.slice(L) });
  }

  ops.sort((x, y) => (x.pos ?? x.at) - (y.pos ?? y.at));
  const stats = scoreOps(ops);
  return { ops, columns, cost: stats.cost, stats };
}

/**
 * 完整对齐：底本标准字数组 × 版本字流（可含缺页标记）。
 * 候选空间 = {正向锚点, 反向锚点转置} × {含换位配对, 不含换位配对}，
 * 取代价最低的结果；同分按「正向锚点优先、含换位优先」确定唯一输出。
 * 代价矩阵在调用方另以双向取小兜底，保证严格正反一致。
 * 返回 { ops, columns, cost, stats }：
 *  - ops：段级差异（substitute / insert / missing / missing_page / transposition）；
 *  - columns：逐底本位的对齐信息（支撑统计用，match 才算支撑）；
 *  - cost：段级总代价。
 */
function alignDetailed(baseChars, tokens) {
  const B = [...baseChars];

  // 拆出实字与缺页边界（gapBefore：版本实字下标 k 之前存在缺页边界）
  const vToks = [];
  const gapBefore = new Set();
  let pendingGap = false;
  for (const t of tokens) {
    if (t.kind === GAP) {
      pendingGap = true;
      continue;
    }
    if (pendingGap) {
      gapBefore.add(vToks.length);
      pendingGap = false;
    }
    vToks.push(t);
  }
  if (pendingGap) gapBefore.add(vToks.length);
  const V = vToks.map((t) => t.norm);

  const anchorSets = [lcsAnchors(B, V)];
  // 反向锚点转置回来仍是 (B, V) 的合法锚点序列，坐标不变
  const transposed = lcsAnchors(V, B).map(([vi, bi]) => [bi, vi]);
  if (!sameAnchorSeq(anchorSets[0], transposed)) anchorSets.push(transposed);

  let best = null;
  for (const anchors of anchorSets) {
    for (const allowMoves of [true, false]) {
      const r = alignWithAnchors(B, vToks, V, gapBefore, anchors, allowMoves);
      if (!best || r.cost < best.cost) best = r;
    }
  }
  return best;
}

function sameAnchorSeq(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k][0] !== b[k][0] || a[k][1] !== b[k][1]) return false;
  }
  return true;
}

module.exports = {
  CHAR,
  GAP,
  charToken,
  gapToken,
  lcsAnchors,
  alignDetailed
};
