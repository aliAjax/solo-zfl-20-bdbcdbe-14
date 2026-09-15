# 拓片多版本校勘服务

零依赖 Node 服务：按列登记各版本字序，多版对齐（插入/缺失/换位），异体字归并，
自动推选底本，支持人工锁定、断点续算、结果回滚。数据持久化在单个 JSON 文件。

## 启动

```bash
# 默认端口 3030，默认数据文件 data/collation.json
node collation/server.js

# 自定义
PORT=3030 COLLATION_DB=data/collation.json node collation/server.js
```

要求 Node.js >= 18（开发用 v20 验证）。启动时会自动恢复上次中断的重算任务：
`running` 状态的任务标记为 `interrupted`，结果落后于当前登记的文本立即补算。

## 运行测试

```bash
node --test collation/
```

覆盖：换位（相邻互换、远距移动、长块、重复字、交叉移动、缺页相邻）、
正反一致（接口矩阵对称 + 小字表穷举）、连续缺字计权、缺页标记、
异体归并与冲突整批拒绝、底本选择与同分规则、人工锁定与重算保留、
回滚、并发登记、断点续跑、支撑版本。

## 计权规则（编辑代价）

| 操作 | 代价 |
| --- | --- |
| 相同（异体归并后相同也算） | 0 |
| 替换 | 每字 1 |
| 插入 | 每个连续段 1（段内长度不计） |
| 缺失 | 每个连续段 1（连续缺字按一段计权） |
| 换位 | 每处 1（任意连续块只移动一次都按一次计，不限块长与距离） |
| 缺页 | 0（缺页标记不当缺字） |

底本选择：对每个版本计算「以它为底、其余版本对齐到它」的代价总和，
取总编辑代价最小者为底本；同分先早登记版本，再按版本编号 `code`，最后按内部 id。
整本缺页（无实字）的版本不作底本候选，除非所有版本都缺页。

**正反一致**：一对版本的比较代价与方向无关——对齐引擎分别以正、反两组
LCS 锚点构建对齐并取代价较低者，代价矩阵再按无序对双向取小，
保证 `cost(A,B) == cost(B,A)` 严格成立（有小字表穷举测试覆盖）。

## 数据模型

- **文本 text**：`{ id, title, note, revision, nextSeq }`。`revision` 在版本/异体/锁定
  变更时递增，用于判断校勘结果是否过期。
- **版本 version**：`{ id, textId, code, seq, columns, note, requestId? }`。
  `seq` 为登记顺序（同分裁决依据）；`columns` 按列号 `no` 升序：
  `{ no, chars, missingPage? }`，`missingPage: true` 表示该列缺页（不得同时登记字）。
- **异体组 variant group**：`{ id, standard, members }`，每个文本一份，
  整批 PUT 替换。每组恰好一个标准字；同一个字不得出现在两个组中，冲突整批拒绝。
- **锁定段 lock**：`{ id, textId, start, end, chars, note }`，钉在底本绝对位置
  `[start, end)`，重算时原位保留（即使底本易主）。
- **校勘结果 result**：底本、逐版差异、逐位支撑版本、代价矩阵等（见查询接口）。
- **重算任务 job**：`{ id, textId, revision, status, pairs, cursor, costMatrix }`，
  按版本对（pair）断点落盘，可中断续跑。

## 接口文档

统一约定：成功返回 `{ data: ... }`；错误返回 `{ error, conflicts? }`。
除标注外，变更类接口都会同步完成重算后再响应——**新增版本后校勘结果立即更新**。

### 文本

- `GET /texts` — 列表（含版本数、当前底本摘要）。
- `POST /texts` — 新建。Body：`{ title, note? }` → 201。
- `GET /texts/:id` — 详情（含校勘摘要）。

### 版本登记

- `POST /texts/:id/versions` — 登记版本并立即重算。Body：

  ```json
  {
    "code": "甲本",
    "columns": [
      { "no": 1, "chars": "天地玄黄" },
      { "no": 2, "missingPage": true },
      { "no": 3, "chars": "宇宙洪荒" }
    ],
    "note": "可选",
    "requestId": "可选，幂等键，重试安全"
  }
  ```

  → 201 `{ data: version, collation }`。缺页列带字 → 400；`code` 重复 → 409；
  相同 `requestId` 重复提交 → 200 返回已存在版本（不重复登记）。
  并发登记由互斥锁串行化，不丢版本。
- `GET /texts/:id/versions` — 按登记顺序列出。
- `DELETE /texts/:id/versions/:vid` — 删除并重算 → `{ deleted, collation }`。

### 异体字组

- `PUT /texts/:id/variants` — 整批替换。Body：`{ groups: [{ standard, members }] }`。
  校验失败（标准字非单字、成员为空、一字跨组）→ 409 且**整批拒绝、状态不变**：

  ```json
  { "error": "异体组冲突，整批已拒绝", "conflicts": [ { "group": 1, "char": "黃", "reason": "..." } ] }
  ```
- `GET /texts/:id/variants` — 查询当前异体组。

### 人工锁定

- `POST /texts/:id/locks` — 锁定底本段落。Body：`{ start, end, note? }`（字符区间，
  左闭右开）。越界 → 400；与已有锁定重叠 → 409；尚无校勘结果 → 409。
  锁定后重算会保留该段的位置与用字。
- `GET /texts/:id/locks` — 列表。
- `DELETE /texts/:id/locks/:lid` — 解锁并重算。

### 校勘查询

- `GET /texts/:id/collation` — 完整结果：

  ```json
  {
    "data": {
      "baseVersionId": "ver_...",          // 底本版本
      "baseText": "天地玄黄宇宙洪荒",        // 底本全文（含锁定段）
      "costs": { "ver_a": 0, "ver_b": 3 }, // 各版本总编辑代价
      "columns": [                          // 逐位：底本字 + 支撑版本
        { "pos": 0, "char": "天", "support": ["ver_a", "ver_b"] }
      ],
      "versions": [                         // 逐版差异
        {
          "id": "ver_b", "code": "乙本", "cost": 3,
          "stats": { "substitute": 1, "insert": 0, "missing": 1,
                     "missingPage": 1, "transposition": 1, "cost": 3 },
          "diff": [
            { "type": "substitute", "pos": 3, "base": "黄", "char": "皇", "raw": "皇" },
            { "type": "missing", "pos": 5, "chars": ["宇", "宙"] },
            { "type": "missing_page", "pos": 8, "chars": ["洪", "荒"] },
            { "type": "insert", "at": 4, "chars": ["之"], "raws": ["之"] },
            { "type": "transposition", "pos": 1, "baseChars": ["玄"], "chars": ["玄"], "movedTo": 3 }
          ]
        }
      ],
      "locks": [ { "start": 2, "end": 4, "chars": "玄黄", "applied": true } ],
      "computedAt": "...", "revision": 5
    }
  }
  ```

### 重算与续跑

- `POST /texts/:id/recompute` — 手动重算。Body 可选 `{ pairBudget: N }`：
  只算 N 个版本对就断点落盘并返回 202（任务状态 `running`），
  用于大文本分批计算；中断期间查询仍返回上一份完整结果。
- `GET /jobs/:id` — 任务状态（`running / interrupted / done / superseded`）。
- `POST /jobs/:id/resume` — 从断点续跑（进程重启后 `interrupted` 任务由此恢复）。

### 回滚

- `POST /texts/:id/rollback` — 恢复上一份校勘结果（每次发布会把旧结果压入历史，
  最多保留 10 份）。历史为空 → 409。被替换的当前结果不保留。

## 设计说明与已知限制

- **对齐**：先求两序列的 LCS 锚点（相对顺序不变的公共字），非锚点内容在
  底本侧为缺失块、版本侧为插入块；同区域的缺失/插入块逐字配为替换，
  多出部分成段。同分候选按固定规则取舍，结果确定。
- **换位**：内容完全相同的缺失块与插入块配成一次换位（公共连续子块，
  极大优先），**不限块长与距离**；候选按（块长降序、位置升序）贪心选配，
  每块只用一次——重复字、交叉移动、缺页相邻均有确定结果。
  没有相同块可配时才按插入和缺失处理。同一对齐会分别以正、反两组
  LCS 锚点各算一遍并取代价较低者，消除锚点选择的偶然性。
- **缺页**：连续缺页列折叠为一个边界；落在缺页区域的底本字记
  `missing_page`、代价 0（缺页不当缺字），版本实字记一段插入。
  已知限制：与缺页区紧邻的个别真缺字会被并入缺页段（底本侧无法区分）。
- **锁定**：锁定段按绝对位置钉在底本上。若重算后底本长度短于锁定区间，
  该锁定标记 `applied: false` 并保留记录，解锁或底本变长后可恢复。
- **并发**：单进程内所有写操作经互斥锁串行化，落盘用临时文件 + rename；
  每个文本的重算也串行排队，计算期间到达的新登记会使任务自动按新修订重算。
- **幂等**：版本登记支持 `requestId` 幂等键，网络重试不会产生重复版本。
