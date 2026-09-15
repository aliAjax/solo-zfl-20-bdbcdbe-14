"use strict";

/**
 * 对齐引擎：把某一版本的列字序列与底本字序列对齐。
 *
 * 字流模型：
 *  - 普通字：{ kind: "char", raw: 原字, norm: 归并后的标准字 }
 *  - 缺页标记：{ kind: "gap" }，一段连续缺页列合并为一个标记，
 *    对齐时可以不花代价地“覆盖”底本中任意长度的连续区段（缺页不计缺字）。
 *
 * 计权规则（段级，详见 README）：
 *  - 替换：每字 1
 *  - 插入 / 缺失：每个连续段 1（段内长度不计）
 *  - 换位：每处 1（相邻互换或整块移动均只算一次）
 *  - 缺页：0
 */

const CHAR = "char";
const GAP = "gap";

const MAX_TRANSPOSE_LEN = 8; // 参与换位的片段最大长度
const MAX_TRANSPOSE_SPAN = 8; // 换位两端允许的最大间距

function charToken(raw, norm) {
  return { kind: CHAR, raw, norm };
}

function gapToken() {
  return { kind: GAP };
}

/**
 * 动态规划对齐。baseChars 为标准字数组（底本侧，不含缺页标记），
 * tokens 为版本侧字流（可含缺页标记）。
 * 返回字级微操作序列（前序）：match / sub / del / ins / mp。
 */
function alignRaw(baseChars, tokens) {
  const n = baseChars.length;
  const m = tokens.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  const parent = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  dp[0][0] = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      const candidates = [];
      if (j === 0) {
        candidates.push({
          cost: dp[i - 1][0] + 1,
          from: [i - 1, 0],
          op: { type: "del", pos: i - 1, char: baseChars[i - 1] }
        });
      } else {
        const tok = tokens[j - 1];
        if (tok.kind === CHAR) {
          if (i > 0) {
            const equal = baseChars[i - 1] === tok.norm;
            candidates.push({
              cost: dp[i - 1][j - 1] + (equal ? 0 : 1),
              from: [i - 1, j - 1],
              op: equal
                ? { type: "match", pos: i - 1, char: tok.norm, raw: tok.raw }
                : { type: "sub", pos: i - 1, base: baseChars[i - 1], char: tok.norm, raw: tok.raw }
            });
            candidates.push({
              cost: dp[i - 1][j] + 1,
              from: [i - 1, j],
              op: { type: "del", pos: i - 1, char: baseChars[i - 1] }
            });
          }
          candidates.push({
            cost: dp[i][j - 1] + 1,
            from: [i, j - 1],
            op: { type: "ins", char: tok.norm, raw: tok.raw }
          });
        } else {
          // 缺页标记：优先“空消耗”（同分时让正常字对齐优先），
          // 其次免费覆盖一个底本字（缺页区段，不计缺字）。
          candidates.push({ cost: dp[i][j - 1], from: [i, j - 1], op: null });
          if (i > 0) {
            candidates.push({
              cost: dp[i - 1][j],
              from: [i - 1, j],
              op: { type: "mp", pos: i - 1, char: baseChars[i - 1] }
            });
          }
        }
      }
      let best = null;
      for (const c of candidates) {
        if (!Number.isFinite(c.cost)) continue;
        if (!best || c.cost < best.cost) best = c; // 同分取先，保证确定性
      }
      if (best) {
        dp[i][j] = best.cost;
        parent[i][j] = best;
      }
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const p = parent[i][j];
    if (!p) break;
    if (p.op) ops.push(p.op);
    i = p.from[0];
    j = p.from[1];
  }
  ops.reverse();
  return { ops, cost: dp[n][m] };
}

/** 把字级微操作合并为段级操作，并识别换位。 */
function buildOps(rawOps, baseLength) {
  const ops = [];
  const columns = new Array(baseLength).fill(null);
  let consumed = 0; // 已消费的底本字数（用于给插入段定位）
  let i = 0;
  while (i < rawOps.length) {
    const op = rawOps[i];
    if (op.type === "match") {
      columns[op.pos] = { op: "match", norm: op.char, raw: op.raw };
      consumed = op.pos + 1;
      i++;
      continue;
    }
    if (op.type === "sub") {
      columns[op.pos] = { op: "substitute", norm: op.char, raw: op.raw };
      ops.push({ type: "substitute", pos: op.pos, base: op.base, char: op.char, raw: op.raw });
      consumed = op.pos + 1;
      i++;
      continue;
    }
    if (op.type === "del" || op.type === "mp") {
      const isMp = op.type === "mp";
      const chars = [];
      const start = op.pos;
      let j = i;
      while (j < rawOps.length && rawOps[j].type === op.type) {
        chars.push(rawOps[j].char);
        columns[rawOps[j].pos] = { op: isMp ? "missing_page" : "missing" };
        j++;
      }
      consumed = start + chars.length;
      ops.push({ type: isMp ? "missing_page" : "missing", pos: start, chars });
      i = j;
      continue;
    }
    // ins 连续段
    const chars = [];
    const raws = [];
    const at = consumed;
    let j = i;
    while (j < rawOps.length && rawOps[j].type === "ins") {
      chars.push(rawOps[j].char);
      raws.push(rawOps[j].raw);
      j++;
    }
    ops.push({ type: "insert", at, chars, raws });
    i = j;
  }
  return { ops: mergeTranspositions(ops), columns };
}

/**
 * 换位识别（启发式，只算一次）：
 *  T1 相邻互换：底本 XY 对版本 YX（两个相邻替换字交叉相同）→ 一次换位。
 *  T2 整块移动：缺失段与插入段字序列完全相同且相距不超过 MAX_TRANSPOSE_SPAN → 一次换位。
 */
function mergeTranspositions(ops) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const a = ops[k];
    const b = ops[k + 1];
    if (
      a && b &&
      a.type === "substitute" && b.type === "substitute" &&
      b.pos === a.pos + 1 &&
      a.base === b.char && b.base === a.char &&
      a.base !== a.char
    ) {
      out.push({ type: "transposition", pos: a.pos, baseChars: [a.base, b.base], chars: [a.char, b.char] });
      k++;
    } else {
      out.push(a);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let mi = 0; mi < out.length && !changed; mi++) {
      const miss = out[mi];
      if (miss.type !== "missing" || miss.chars.length > MAX_TRANSPOSE_LEN) continue;
      for (let ii = 0; ii < out.length; ii++) {
        const ins = out[ii];
        if (ins.type !== "insert") continue;
        if (ins.chars.join("") !== miss.chars.join("")) continue;
        if (Math.abs(ins.at - miss.pos) > MAX_TRANSPOSE_SPAN) continue;
        const trans = {
          type: "transposition",
          pos: miss.pos,
          baseChars: miss.chars,
          chars: ins.chars,
          movedTo: ins.at
        };
        out.splice(Math.max(mi, ii), 1);
        out.splice(Math.min(mi, ii), 1);
        out.push(trans);
        changed = true;
        break;
      }
    }
  }

  out.sort((x, y) => (x.pos ?? x.at) - (y.pos ?? y.at));
  return out;
}

/** 段级计权：替换每字 1，插入/缺失每段 1，换位每处 1，缺页 0。 */
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
 * 完整对齐：返回段级差异 ops、逐位列信息 columns（供支撑统计）、
 * 段级代价 cost 与统计 stats。
 */
function alignDetailed(baseChars, tokens) {
  const { ops: raw } = alignRaw(baseChars, tokens);
  const { ops, columns } = buildOps(raw, baseChars.length);
  const stats = scoreOps(ops);
  return { ops, columns, cost: stats.cost, stats };
}

module.exports = {
  CHAR,
  GAP,
  charToken,
  gapToken,
  alignRaw,
  alignDetailed,
  MAX_TRANSPOSE_LEN,
  MAX_TRANSPOSE_SPAN
};
