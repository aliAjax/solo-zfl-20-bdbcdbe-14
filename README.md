# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```

## 多版本校勘服务

`collation/` 目录是独立的校勘服务（默认端口 3030）：按列登记各版本字序、
异体字归并、多版对齐（插入/缺失/换位/缺页）、自动推选底本、人工锁定、
断点续算与结果回滚。

```bash
node collation/server.js     # 启动
node --test collation/       # 运行测试
```

详见 [collation/README.md](collation/README.md)。
