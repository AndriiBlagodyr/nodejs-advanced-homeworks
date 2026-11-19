# Course project

Marketplace API. One NestJS service, Postgres, and one business contour: an authenticated caller places an order, the stock check and the outbox row commit together, and a second request reads that order back. The sections below this one are the homework notes. This section is the map a reviewer uses.

The running system is the repository root. Folders `hw-03` through `hw-29` are snapshots of earlier steps, copied when the next homework started. HW-31 and HW-32 were not copied again: their code is the current root (`infra/base`, `infra/demo`, `.github/workflows`, `oidc/`). Moving it into new folders would split the service the acceptance run starts.

## Main contour

Place an order, then read it back.

1. `POST /orders` with a bearer access token and an `Idempotency-Key`.
2. The body is validated (`CreateOrderDto`). A bad body does not reach the stock check.
3. `AuthGuard` rejects a missing or dead token with 401. Reading or streaming someone else's order returns 403.
4. `placeOrder` decrements stock with `stock >= quantity` in the same transaction as the order and the `order.placed` outbox row. A shortfall rolls the order back.
5. The order row is in Postgres. A replay of the same idempotency key returns the same order and `Idempotent-Replayed: true`.
6. The relay publishes the outbox row to RabbitMQ. That is the background step. The order is already stored before the broker sees it.
7. `GET /orders/:orderId` returns the stored order. `GET /orders/:orderId/events` is the owner's stream of status events.
8. The request log line and the trace share one id. Metrics are the RED series. The dashboard is `observability/grafana/dashboards/red.json`.
9. `npm run test:e2e` covers the HTTP contour. `npm run test:unit` covers the business rules without HTTP. `npm run test:integration` hits the real database.
10. The same image digest is what the pipeline deploys into kind. The green run is [pipeline 44399064478](https://github.com/AndriiBlagodyr/nodejs-advanced-homeworks/actions/runs/44399064478). The push to `main` after that merge is [deploy 44478884659](https://github.com/AndriiBlagodyr/nodejs-advanced-homeworks/actions/runs/44478884659).

Liveness is `GET /healthz`. Readiness is `GET /readyz`. They are different paths.

## Local run and tests

One command starts every component of this contour: Postgres, PgBouncer, RabbitMQ, both Redis instances, the object store, Jaeger, Prometheus, and Grafana.

```bash
docker compose up -d --wait
```

The acceptance exports, the vault bypass, and the three observability demos are the block under `## Grading` further down. `npm run start` exits non-zero and names every missing variable when the config is broken. It does not open the database first.

```bash
npm ci
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:contract
```

The API contract is `openapi.yaml`.

## Block and path

Every block uses the course tool. Nothing was replaced.

| Block | Path | Where it is | Why this and not another |
| --- | --- | --- | --- |
| Architecture note | course, this section | root README | The homework notes stay below. This section is the decision record. |
| API contract | course, OpenAPI | `openapi.yaml` | The machine diff is `scripts/contract-diff.mjs`, run in the pipeline. |
| Config fails closed | course | `npm run start` | A missing variable is a non-zero exit that names the variable. |
| Secrets | course, vault from HW-11 | `scripts/with-secrets.sh` | Values are not in git. The acceptance run sets `SKIP_VAULT=1` and exports them. |
| Schema and migrations | course, TypeORM | `src/migrations` | The schema is applied by `npm run migrate`, not by synchronize. |
| No lost update | course | `src/orders/place-order.ts` | The stock check and the insert share one transaction. |
| Pool and backup | course | `pgbouncer` service, `RESTORE-DRILL.md` | The app talks to the pooler. The restore drill is the proof the backup can be read. |
| Authentication and ownership | course, HW-24 | `src/auth` | 401 is the guard. 403 is the ownership check in the order service. |
| Validation | course | DTO on `POST /orders` | class-validator rejects the body before the transaction. |
| Background work | course, outbox and RabbitMQ | `src/outbox`, `npm run relay` | The publish happens after the commit, from the relay. |
| Realtime | course | `GET /orders/:id/events` | The stream is only for the owner of that order. |
| Redis | course, HW-23 | `src/redis` | Cache, session, rate limit, and the receipts queue are separate uses. |
| Files | course, HW-26 | `src/files` | Presigned upload. Not part of the order contour. |
| Local Docker | course | `docker-compose.yml`, `docker/` | `docker compose up -d --wait`. The production image is multi-stage and distroless. |
| Deploy described as code | course, Pulumi and kind | `infra/`, `k8s/` | `npm run up` applies the digest. `demo:rollout` requires `failed=0`. |
| Deploy off the laptop | course, both accepted forms | links below | The pipeline deploys into kind on the runner. The AWS stack was created and then destroyed. |
| Health, logs, metrics, traces | course, HW-29 | `src/observability`, `observability/` | `demo:logs`, `demo:metrics`, `demo:trace`. |
| Tests and pipeline | course, HW-32 | `.github/workflows/pr.yml` | Four gates, each fails on a broken input. The image is built once. |

## Trade-offs

Chose one service and one order contour, because a second service would add a deploy and no new proof. The cost is that files, cache, and orders share a process.

Chose the outbox row in the same transaction as the order, because publishing to RabbitMQ inside the transaction would lie if the broker accepted and the database rolled back. The cost is a relay and at-least-once delivery.

Chose kind on the GitHub runner as the deploy the pipeline proves, because a public host was not a homework. The AWS program is the other accepted proof, and it is torn down. The teardown run with six zeros is [44171907792](https://github.com/AndriiBlagodyr/nodejs-advanced-homeworks/actions/runs/44171907792).

## Decision log

- Orders stay the main contour. Products, files, and the cache are supporting modules.
- Secrets stay in the HW-11 vault. CI generates one-job values and masks them. Nothing cloud-shaped is a repository secret.
- The image is promoted by digest. The tag is only a name for humans and for `kind load`.
- HW-31 is destroyed on a schedule. The account does not keep the stack between reviews.
- Snapshot folders stop at `hw-29`. Later homework stays at the root so `npm ci` and `docker compose` have one project.

## Environment

| Variable | джерело | What it is for |
| --- | --- | --- |
| `DATABASE_URL` | local Postgres container, or the vault in a deployed pod | Application database. |
| `APP_DB_PASSWORD` | vault (HW-11); acceptance run exports it | Password the pod and Postgres use. |
| `BROKER_URL` | compose default `amqp://app:app@127.0.0.1:5672` | RabbitMQ for the outbox relay. |
| `REDIS_URL` | compose, port 6390 | Cache, sessions, rate limit. |
| `REDIS_QUEUE_URL` | compose, port 6391 | BullMQ receipts queue. |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID`, `REFRESH_TOKEN_PEPPER` | vault; the acceptance run generates a one-time P-256 pair | Access tokens and refresh-token hashes. |
| `STORAGE_*` | compose MinIO values in the Grading block | File uploads. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `PROMETHEUS_URL`, `TRACE_API_URL` | the Jaeger and Prometheus services in compose | Traces and the RED scrape. |
| `SKIP_VAULT` | set to `1` by the acceptance run | The runner has no vault. |
| `PULUMI_CONFIG_PASSPHRASE` | generated for the CI job, not committed | Encrypts the local Pulumi file backend. |
| `NPM_TOKEN`, `PACT_BROKER_URL`, `PACT_BROKER_TOKEN` | GitHub Actions secrets, declared in the CI/CD section | Image build and the optional Pact broker. |

Rotation: a new JWT pair is a new `kid`. Old access tokens die with their expiry. Reuse of a refresh token revokes the family. The CI job does not rotate a long-lived cloud key, because it does not have one.

# HW-29 — Observability: one key from the log to the span

The question is no longer "does the service survive a rollout" (HW-28) but
"at 03:15 one request returned 500 — how long until you can say what
happened". The answer is a minute, not an evening: a JSON line, a RED
dashboard, and a trace whose `trace_id` is the same in the log, the span
and the incoming `traceparent`.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`, `hw-19/`, `hw-22/`, `hw-23/`, `hw-24/`, `hw-26/`, `hw-28/`, `hw-29/`.

## AWS

смуга: основна
https://github.com/AndriiBlagodyr/nodejs-advanced-homeworks/actions/runs/44171907792
Лог цього `workflow_dispatch` закінчується шістьма нулями: `state-resources-left=0`, `tagged-resources-left=0`, `rds-left=0`, `alb-left=0`, `nat-left=0`, `eip-left=0`.
Регіон: `eu-central-1`. Програми Pulumi — `infra/base` і `infra/demo`. Failover зайняв 142 секунди, це поза спостереженням 60–120, але в межах критерію 20–600. Сім скриптів `up:base`, `up:demo`, `destroy:demo`, `destroy:base`, `demo:failover`, `demo:nat`, `demo:alb` оголошені в кореневому `package.json`, не в `hw-05/package.json` (його `git ls-files` віддає першим). Усі сім ідуть через `scripts/with-secrets.sh`.

Цей акаунт AWS уже існував до завдання, тож Free plan і кредити недоступні. З першої хвилини списуються живі гроші: бюджет і нічне знесення — єдиний захист.

Не створюй AWS Organizations і не підіймай Control Tower. З FAQ: кредити Free Tier згорають одразу, free account plan сам стає paid, і назад на Free повернутись не можна.

### Погодинна ставка

Місяць — 730 годин. Рядки Франкфурта нижче — знімок прайс-листа з умови, дата публікації в тексті ДЗ **24.08.2026**. 16.11.2026 публічна сторінка ALB віддала лише американський приклад $0,0225/год і не віддала рядок eu-central-1 (JSON прайсу відповідав 403/404). Курс НБУ на 16.11.2026 — **45,4274 грн/$**. Якщо бодай один франкфуртський рядок зміниться, перерахуй усі похідні.

| Рядок | Ставка (знімок 24.08.2026) | 730 год | грн за 730 год |
| --- | --- | --- | --- |
| ALB | $0,02700/год | $19,71 | 895,37 |
| RDS db.t4g.micro PostgreSQL, Multi-AZ instance | $0,03700/год | $27,01 | 1226,99 |
| gp3 20 ГіБ, Multi-AZ ($0,274/ГіБ-міс × 20) | $5,48/міс | $5,48 | 248,94 |
| Public IPv4 × 2 під ALB | $0,00500/год × 2 | $7,30 | 331,62 |
| LCU | припущення навчального навантаження, не рядок прайсу | $0,29 | 13,17 |
| Разом | $0,08191/год | $59,79 | 2716,10 |

Похідні з того самого числа: 4 год = $0,33 ≈ 15,00 грн; доба = $1,97 ≈ 89,49 грн. $200 кредитів ÷ $1,97 ≈ 101 доба. NAT, якого в постійному стеку немає, коштує $0,052/год плюс його Public IPv4 $0,005: одна білена година вправи = $0,057. Лаг бюджету 12 год × $0,08191 = $0,98. Мінімум RDS 10 хвилин: $0,0370 × 10/60 = $0,0062. Округлення різне: часткова година NAT і ALB білиться як повна; RDS — посекундно, але не менше десяти хвилин.

### Дозволи ролі `hw31-gha-teardown`

Trust: `Principal.Federated` на `token.actions.githubusercontent.com`, `StringEquals` на `aud` = `sts.amazonaws.com`, `StringLike` на `sub` = `repo:AndriiBlagodyr/nodejs-advanced-homeworks:*` і на незмінний суб'єкт цього репозиторію `repo:AndriiBlagodyr@44027355/nodejs-advanced-homeworks@1345837420:*`. GitHub для цього репозиторію віддає саме другий `sub`, тож без нього `AssumeRoleWithWebIdentity` повертає AccessDenied. В `Action` зірки немає. `Resource: "*"` стоїть там, де API EC2, RDS, ELB і Budgets не приймають ARN ресурсу. `iam:PutRolePolicy` і `iam:AttachRolePolicy` обмежені `role/hw31-*`. Бакет стану обмежений його власним ARN.

- `budgets:ModifyBudget` — створити і змінити бюджет $5.
- `budgets:ViewBudget` — прочитати бюджет під час destroy.
- `budgets:ListTagsForResource` — теги бюджету: default tags провайдера пишуть їх на ресурс.
- `budgets:TagResource` — теги бюджету: default tags провайдера пишуть їх на ресурс.
- `budgets:UntagResource` — теги бюджету: default tags провайдера пишуть їх на ресурс.
- `ec2:DescribeAvailabilityZones` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeVpcs` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeVpcAttribute` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeSubnets` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeInternetGateways` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeRouteTables` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeSecurityGroups` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeSecurityGroupRules` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeNatGateways` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeAddresses` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeAddressesAttribute` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeNetworkInterfaces` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:DescribeAccountAttributes` — прочитати мережу, NAT або адресу в перевірках знесення.
- `ec2:CreateVpc` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteVpc` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:ModifyVpcAttribute` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateSubnet` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteSubnet` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:ModifySubnetAttribute` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateInternetGateway` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteInternetGateway` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:AttachInternetGateway` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DetachInternetGateway` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateRouteTable` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteRouteTable` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:AssociateRouteTable` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DisassociateRouteTable` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateRoute` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteRoute` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:ReplaceRoute` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateSecurityGroup` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteSecurityGroup` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:AuthorizeSecurityGroupIngress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:AuthorizeSecurityGroupEgress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:RevokeSecurityGroupIngress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:RevokeSecurityGroupEgress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateNatGateway` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteNatGateway` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:AllocateAddress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:ReleaseAddress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:AssociateAddress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DisassociateAddress` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:CreateTags` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DeleteTags` — створити або знести VPC, підмережу, IGW, маршрут, security group, NAT чи Elastic IP.
- `ec2:DescribeTags` — прочитати мережу, NAT або адресу в перевірках знесення.
- `rds:CreateDBInstance` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:DeleteDBInstance` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:DescribeDBInstances` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:ModifyDBInstance` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:RebootDBInstance` — керований failover, --force-failover.
- `rds:ListTagsForResource` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:AddTagsToResource` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:RemoveTagsFromResource` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:CreateDBSubnetGroup` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:DeleteDBSubnetGroup` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:DescribeDBSubnetGroups` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:ModifyDBSubnetGroup` — створити, змінити або знести Multi-AZ інстанс і subnet group.
- `rds:DescribeEvents` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:DescribeOrderableDBInstanceOptions` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:DescribeDBEngineVersions` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:DescribeDBSnapshots` — прочитати інстанс, subnet group, снапшот або подію failover.
- `rds:DeleteDBSnapshot` — прибрати снапшот, якщо він лишився у стані.
- `elasticloadbalancing:CreateLoadBalancer` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DeleteLoadBalancer` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DescribeLoadBalancers` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:DescribeLoadBalancerAttributes` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:ModifyLoadBalancerAttributes` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:SetSecurityGroups` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:SetSubnets` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:CreateTargetGroup` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DeleteTargetGroup` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DescribeTargetGroups` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:DescribeTargetGroupAttributes` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:ModifyTargetGroup` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:ModifyTargetGroupAttributes` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DescribeTargetHealth` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:RegisterTargets` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DeregisterTargets` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:CreateListener` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DeleteListener` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DescribeListeners` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:DescribeListenerAttributes` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:DescribeRules` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:ModifyListener` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:DescribeTags` — прочитати ALB, listener, target group або стан цілі.
- `elasticloadbalancing:AddTags` — створити або знести ALB, listener і target group.
- `elasticloadbalancing:RemoveTags` — створити або знести ALB, listener і target group.
- `lambda:CreateFunction` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:DeleteFunction` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:GetFunction` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:GetFunctionConfiguration` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:GetFunctionCodeSigningConfig` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:GetRuntimeManagementConfig` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:UpdateFunctionCode` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:UpdateFunctionConfiguration` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:AddPermission` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:RemovePermission` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:GetPolicy` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:ListVersionsByFunction` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:TagResource` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:UntagResource` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `lambda:ListTags` — функція, яку викликає ALB, і дозвіл на цей виклик.
- `iam:CreateRole` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:DeleteRole` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:GetRole` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:GetPolicy` — прочитати AWSLambdaBasicExecutionRole під час refresh.
- `iam:GetPolicyVersion` — прочитати AWSLambdaBasicExecutionRole під час refresh.
- `iam:UpdateAssumeRolePolicy` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:PassRole` — передати роль виконання Lambda; користувачів ця роль не створює.
- `iam:TagRole` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:UntagRole` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:ListRolePolicies` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:PutRolePolicy` — лише `role/hw31-*`: роль не може дописати політику чужій ролі.
- `iam:GetRolePolicy` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:DeleteRolePolicy` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:ListAttachedRolePolicies` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:AttachRolePolicy` — лише `role/hw31-*`: роль не може прикріпити політику чужій ролі.
- `iam:DetachRolePolicy` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:ListInstanceProfilesForRole` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:CreateOpenIDConnectProvider` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:DeleteOpenIDConnectProvider` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:GetOpenIDConnectProvider` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:ListOpenIDConnectProviders` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:TagOpenIDConnectProvider` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:UntagOpenIDConnectProvider` — OIDC provider, роль CI і роль виконання Lambda.
- `iam:UpdateOpenIDConnectProviderThumbprint` — OIDC provider, роль CI і роль виконання Lambda.
- `tag:GetResources` — знайти хвости за тегом Project=nodejs-pro-hw31.
- `s3:ListBucket` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:GetBucketLocation` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:GetBucketVersioning` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:ListBucketVersions` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:ListBucketMultipartUploads` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:GetObject` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:PutObject` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:DeleteObject` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:AbortMultipartUpload` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:ListMultipartUploadParts` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:GetObjectVersion` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.
- `s3:DeleteObjectVersion` — читати і писати стан Pulumi лише в бакеті HW31_STATE_BUCKET.

Негативний тест, обидва прогони на AWS, не в емуляторі:

```
aws iam simulate-principal-policy --policy-source-arn <arn ролі> --action-names rds:DescribeDBInstances
aws iam simulate-principal-policy --policy-source-arn <arn ролі> --action-names iam:CreateUser
```

`node scripts/hw31/evidence-iam.mjs` (через `scripts/with-secrets.sh`) пише розкодовані trust + permission policy в `evidence/iam.json` і рядки `sim-allowed=` / `sim-denied=` в `evidence/iam.txt`. Поки `up:base` не виконано, цих файлів немає: підставляти `allowed` руками не можна.

### RDS Multi-AZ проти стека з #15

Стек #15 — один Postgres, PgBouncer попереду і `scripts/backup.sh` (`pg_dump -Fc`) плюс restore-drill. Streaming replica там прямо винесена за межі роботи. RDS забирає на себе синхронний standby в іншій AZ (це не читабельна репліка), автоматичні бекапи з `backupRetentionPeriod: 1`, шифрування диска ключем AWS `aws/rds` і керований failover. Він не замінює PgBouncer, не дає репліку, з якої можна читати, і не замінює логічний дамп поза коробкою: снапшот RDS лежить у тому самому акаунті, а `backup.sh` лишається окремим drill. Відповідь не «усе».

### KMS

KMS — не заміна сховищу з #11, а шар під ним: ключ, яким шифрується `ENCRYPTION_KEY`. Сам ключ застосунку і JWT як і раніше приїжджають зі сховища через `scripts/with-secrets.sh`. `storageEncrypted: true` на RDS використовує ключ AWS `aws/rds`. Власний customer-managed key не створюється: це рядок рахунку, який не зникає від `destroy` того ж дня. Бакет стану теж шифрується SSE-S3 (AES256), не CMK.

### Чим бекенд стану відрізняється від #28

На #28 бекенд — `file://$PWD/.pulumi`. Воркер GitHub цей каталог не бачить, тому `destroy` з Actions не дійшов би до стека. Тут бекенд — приватний S3-бакет у тому самому акаунті (`PULUMI_BACKEND_URL=s3://$HW31_STATE_BUCKET`), без тега `Project` (інакше перевірка хвостів не стане нулем, доки бакет живий). Доступ CI — та сама OIDC-роль, не ключ і не токен Pulumi Cloud. Пароль бази й пошта бюджету після `up` лежать у конфізі стека, тож нічний `destroy` їх не питає. `PULUMI_CONFIG_PASSPHRASE=hw31-not-a-secret` однаковий локально і в workflow. Це не секрет: бакет приватний, а роль звужена до репозиторію. Не роби `pulumi login` і `aws configure` — вони переписують глобальний стан. `pulumi config set --secret hw31:dbPassword` дописує шифротекст у `infra/demo/Pulumi.demo.yaml`; цей рядок не коміть.

Теги (`Project=nodejs-pro-hw31`, `Stack`, `ManagedBy=pulumi`) і регіон стоять у `Pulumi.<stack>.yaml` і ще раз на явному `aws.Provider`, щоб регіон не брався з `~/.aws/config`. Бюджет — на весь акаунт, без фільтра по тегу: як cost-allocation key тег починає працювати не одразу. Бюджет — перший ресурс, VPC чекає на нього. Лист, не гальмо: `ACTUAL`, поріг 20% від $5, `FORECASTED` немає.

Приватна таблиця маршрутів не має `0.0.0.0/0` на IGW. NAT за прапорцем створюється в demo і не вішається на цю таблицю. Ціль ALB — Lambda, не EC2, щоб у таблицю не потрапив ще один погодинний інстанс і ще одна Public IPv4. Hosted zone не створюється. Трансформ на `aws:rds/instance:Instance` виставляє `deletionProtection: false` і `skipFinalSnapshot: true` до створення інстанса.

Перевірки порожнечі в `.github/workflows/teardown.yml` друкують кожен ключ один раз: сума `eu-central-1` і `us-east-1`. Порядок джоби — destroy demo (поки base ще існує), destroy base, `stack export`, потім шість чисел. `--remove` до export не викликається. GitHub Actions variables, не Secrets: `HW31_CI_ROLE_ARN` (вихід `ciRoleArn`) і `HW31_STATE_BUCKET`.

Після зданого прогону знеси і base (`npm run destroy:base`): він коштує $0, але роль із правом знесення не має жити довше за курс. Бакет стану видали окремо, вже після шести нулів у логу.

### Що ще видно з рахунку

Два NAT Gateway (по одному на AZ) за ставками знімка: $0,052 × 2 × 730 = $75,92 плюс дві Public IPv4 $7,30, разом $83,22. У чужому прогоні 24.08.2026 топологія з двома NAT вийшла $142,72/міс, і NAT разом зі своїми адресами був 58,3%. Цих позицій немає на схемі. Стокгольм у тому прогоні дешевший на 9,8%, нерівномірно (NAT −11,5%, ALB −11,3%, RDS −11%, Public IPv4 і егрес ті самі). Свій стек у eu-north-1 я не піднімав: 16.11.2026 франкфуртський прайс не віддався, тож різницю не вигадую.

Gateway endpoint для S3 безкоштовний і замінює NAT лише для трафіку до S3 в тому самому регіоні. Він не дає виходу до Docker Hub, до RDS API і до будь-якого іншого адресата: для них як і раніше потрібен NAT або публічна підмережа. Interface endpoint, на відміну від gateway, тарифікується погодинно.

Дія бюджету, яка зупиняє RDS, прийде з тим самим лагом 8–12 годин. За 12 годин цей стек встигає намотати близько $0,98, і вона не знімає ALB, його дві Public IPv4 і NAT. Лист і тип акаунта зупиняють рахунок раніше, ніж ця дія.

## Observability

**Stand: three containers next to the existing compose stack** (Jaeger
all-in-one, Prometheus, Grafana). `grafana/otel-lgtm` starts faster (about
9 s vs 26 s) but sits at 240 MiB idle and up to 614 MiB under load; four
separate containers were 165 MiB on the lecture. With the HW-28 kind node
already around 1.65 GiB, the cheaper stand is the one that still fits.
Ports are in `22900–22999`. `docker stats --no-stream` after
`docker compose up -d --wait` is written under **Demos**.

### Pieces

| Piece | Where |
| --- | --- |
| pino JSON logger, mixin reads the active span | `src/observability/logger.ts` |
| ALS (`userId`, `tenant`, `idempotencyKey`) | `src/observability/context.ts` |
| RED counter + histogram, route template | `src/observability/metrics.ts` |
| OTel SDK (`--require` before Nest) | `src/observability/instrumentation.ts` |
| compose stand, Grafana datasource, dashboard JSON | `observability/` |
| demos | `src/demos/demo-logs.ts`, `demo-metrics.ts`, `demo-trace.ts` |

### Variables

| Змінна | Джерело | Навіщо |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | сховище (#11) | OTLP HTTP base (`http://127.0.0.1:22918`); the SDK appends `/v1/traces` |
| `PROMETHEUS_URL` | сховище (#11) | Prometheus, `http://127.0.0.1:22901` |
| `TRACE_API_URL` | сховище (#11) | Jaeger query API, `http://127.0.0.1:22904` |
| `GRAFANA_USER` | сховище (#11) | Grafana admin user |
| `GRAFANA_PASSWORD` | сховище (#11) | Grafana admin password |
| `JWT_PRIVATE_KEY` | сховище (#11) | demos boot the real API (HW-24) |
| `JWT_PUBLIC_KEY` | сховище (#11) | verifier of the current kid |
| `JWT_KID` | сховище (#11) | signing key id |
| `REFRESH_TOKEN_PEPPER` | сховище (#11) | refresh-token hashes |
| `DATABASE_URL` | compose / оточення | PgBouncer in front of Postgres |
| `METRICS_TARGET` | оточення | full `host:port` Prometheus should scrape; empty means host + the bound port |
| `METRICS_TARGET_HOST` | оточення | host when `METRICS_TARGET` is empty (default `host.docker.internal`) |
| `DEMO_ROUTES` | оточення | `1` mounts `/demo/fail` and `/demo/flush`; unset in `npm start` |
| `SKIP_VAULT` | environment | `1` for the grader: values come from `export` |

The addresses and Grafana credentials come through `scripts/with-secrets.sh`
(the same wrapper as #11). No new env-file. The demos fail naming a missing
OTel/Prometheus/Jaeger URL. `npm run start` still only names the auth and
storage secrets: a missing collector must not hide a missing signing key.

### Logs: correlator from the span, not from a uuid

Every line is JSON. The mixin does
`trace.getActiveSpan()?.spanContext().traceId` — a homemade uuid would make
`trace-id-matches-header=0` and `trace-matches-log=0`. No function takes
`req` to log; tenant and `Idempotency-Key` live in `AsyncLocalStorage`,
`userId` is patched in the HW-24 guard. `logger.child({ layer })` names the
component. `GET /products/:productId` goes through controller, service and
repository with the same `trace_id`.

Redact is by key name, at any depth. A key matching `authorization`,
`password`, `secret`, `token`, `api key` or `cookie` is replaced with
`[Redacted]`, so a field that was never listed still loses its value.
`email`, `note`, `trace_id` and `userId` stay. `/auth/*` bodies are not
logged at all (HW-24 login and refresh). `demo:logs` sends
`Authorization: Bearer <marker>` and a password with a second marker; the
request line is there, the markers are not.

### Metrics: RED, template route, buckets that cover the range

- Counter `http_requests_total{method,route,status}` and histogram
  `http_request_duration_seconds` with the same labels.
- `route` is the template (`/products/:productId`), from `req.baseUrl` +
  `req.route.path`. A hundred different ids do not add a series.
- Prometheus scrapes `observability/sd/targets.json` (file service discovery),
  not a hardcoded `:3000`. After `listen()`, the process writes
  `METRICS_TARGET` when that is set, otherwise
  `METRICS_TARGET_HOST` (default `host.docker.internal`) plus the port it
  actually bound. Demos listen on port 0, on all interfaces. Prometheus scrapes
  once after a single counted request and twice around the demo traffic, with
  one more counted request between those two, so `rate()` has an increase even
  for a series that first appears during the demo (a 500).
- `/demo/fail` and `/demo/flush` are mounted only when `DEMO_ROUTES=1`.
  `npm start` leaves them off. `demo:metrics` and `demo:trace` set the flag
  before the process starts.
- Buckets: `5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s`. The slow
  demo request sleeps 800 ms. The top finite `le` is 2 s, so
  `histogram_quantile` cannot sit on the last bucket while everything is
  actually worse. `above-top-bucket` is `_count` minus `_bucket{le="2"}`
  for `/demo/fail`.

### Traces: one key, two doors

Incoming `traceparent` (`00-<32 hex>-<16 hex>-01`) is the active span.
`GET /demo/fail` returns 500 on purpose: OTel leaves 4xx Unset, so only 5xx
sets ERROR. The handler opens a nested span around `SELECT 1` and marks it
ERROR too. `POST /demo/flush` calls `forceFlush()` so the collector has the
spans before the demo asks Jaeger. `trace_id` in the log line equals the
span and the header.

### Dashboard (three RED questions)

JSON: `observability/grafana/dashboards/red.json`. Datasource provisioned
in `observability/grafana/provisioning/datasources/prometheus.yml`.

| Panel | Question | PromQL |
| --- | --- | --- |
| Rate | How busy is it? | `sum(rate(http_requests_total[1m]))` |
| Errors | How much of that is 5xx? | `sum(rate(http_requests_total{status=~"5.."}[1m]))` |
| Duration | How long do the slow ones take? | `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[1m])) by (le))` |

Windows are `[1m]` so a minute-long demo moves the line.

**SLO.** The SLI is the share of `http_requests_total` whose `status` is not
`5xx`, measured by the Errors panel. The SLO is 99.5% of requests over 30
days. The error budget is `0.005 × 30 × 24 × 60 = 216` minutes per month:
that is how long the API may serve 5xx before the budget is spent.

### Demos, from my runs

Each demo migrates, boots the API on port 0 (bound on all interfaces so
Prometheus can scrape it), drains captured pino lines (or `/metrics`) at
the start, and exits non-zero if the invariant fails.

```text
$ npm run demo:logs
non-json-lines=0  layers=3  distinct-trace-ids=1  trace-id-matches-header=1
burst=8  burst-trace-ids=8  burst-uneven=0  secret-req-logged=1  secret-in-logs=0

$ npm run demo:metrics
sent-ok=40  sent-fail=16  counter-delta=56  errors-delta=16
above-top-bucket=0  series-before=1  series-after=1

$ npm run demo:trace
spans=2  orphan-spans=0  trace-matches-header=1  trace-matches-log=1  span-status-error=1
```

`docker stats --no-stream` after compose is up (API not in the stand):
Jaeger 15 MiB, Prometheus 20 MiB, Grafana 79 MiB — about 114 MiB together,
next to the existing Postgres / Redis / Rabbit / MinIO services.

# HW-28 — Kubernetes: a rolling update under load, measured

The course API (the same Nest app as HW-22…26) runs on a local one-node kind
cluster, next to its own Postgres. The question is no longer "does the image
start" but "does it survive an update under load". The answer is a number
from a file of response codes: `failed=0` on about 11 000 requests during a
rollout, run after run.

## Kubernetes

**Cluster: kind v0.33.0 (Kubernetes v1.37.0, one node), on Docker Desktop
with 7.65 GiB of memory and 10 CPUs allocated.** The node container uses about
1.65 GiB with the whole stack running (control plane, 3 API pods, Postgres).
kind is the smaller option on a small Docker VM, and minikube refuses to start
below 1800 MB; here memory was not the limit, kind was the choice.

### Pieces

| Piece | Where |
| --- | --- |
| production image: 4 stages, distroless `nonroot`, BuildKit secret | `docker/Dockerfile`, `npm run image:build` |
| container entrypoint: warm-up, readiness, SIGTERM drain | `src/k8s/serve-main.ts`, `src/k8s/lifecycle.ts` |
| cluster config (one node, NodePort 30080 → host 28080) | `k8s/kind-config.yaml`, `npm run cluster:up` / `cluster:down` |
| Pulumi program (TypeScript): Namespace, Secret, Postgres, Deployment, Service, PDB, HPA | `infra/`, `npm run up` / `destroy` |
| shared names (context, namespace, image, ports) | `k8s/names.json` |
| vault wrapper, load generator, scan gate | `scripts/with-secrets.sh`, `scripts/load.mjs`, `scripts/scan.mjs` |
| demos | `demo/image.mjs`, `demo/rollout.mjs`, `demo/pdb.mjs` |
| CI step with the working scan threshold | `.github/workflows/image-scan.yml` |

### Variables

| Змінна | Джерело | Навіщо |
| --- | --- | --- |
| `APP_DB_PASSWORD` | сховище (#11) | Postgres password; goes into the K8s Secret as `DB_PASSWORD`, used by Postgres and the API |
| `JWT_PRIVATE_KEY` | сховище (#11) | base64 PKCS#8 PEM, signs access tokens (HW-24); K8s Secret |
| `JWT_PUBLIC_KEY` | сховище (#11) | base64 SPKI PEM of the current key; K8s Secret |
| `JWT_KID` | сховище (#11) | key id of the signing key; K8s Secret |
| `REFRESH_TOKEN_PEPPER` | сховище (#11) | HMAC pepper for refresh-token hashes; K8s Secret |
| `PULUMI_CONFIG_PASSPHRASE` | сховище (#11) | encrypts the secrets in the Pulumi state |
| `PULUMI_BACKEND_URL` | environment | local file backend, `file://$PWD/.pulumi`; never `pulumi login` |
| `SKIP_VAULT` | environment | `1` for the grader: values come from `export` |
| `.npm_token` (file) | local file, not in git | registry token for `npm ci`, BuildKit secret at build time only |

The Pulumi program checks the vault values first, before it creates a
provider. Without one, `pulumi preview` exits non-zero with
`missing required secret: <NAME>`. Without the passphrase, Pulumi itself
stops and names `PULUMI_CONFIG_PASSPHRASE`. No defaults anywhere. The vault
names from HW-24/HW-26 that this stack does not use (`STORAGE_*`,
`JWT_PUBLIC_KEYS`) are marked `vault (#11)` in their old tables.

### Image

`docker/Dockerfile` has four stages:
- `deps` runs `npm ci` with the token;
- `build` runs `tsc` (`tsconfig.build.json`, `src` only);
- `prod-deps` runs `npm ci --omit=dev` with the token;
- the final stage is `gcr.io/distroless/nodejs22-debian12:nonroot`, with only
  `node_modules` and `dist/src`, `USER 65532:65532`.

There is no `sh` in the final image, so after an RCE the attacker has no
shell to run. That is the reason for distroless here, not the size (264 MB,
mostly `node_modules`).

**Build secret.** The project has no private registry. `docker/npmrc` points
a private scope (`@hw28-private`) at a registry with
`_authToken=${NPM_TOKEN}`. The value is a BuildKit secret: `RUN
--mount=type=secret,id=npm_token,required=true`, read into `NPM_TOKEN` for
that one `npm ci`. `.npm_token` is in `.gitignore` and `.dockerignore`. Not an
ARG: an ARG lands in the image history. Not COPY + rm: the bytes stay in the
COPY layer under a whiteout.

`demo:image` reads every number from Docker:
- `stages`: `FROM` lines in `docker/Dockerfile`;
- `shell-inside`: `docker run --entrypoint` with `sh`, `/bin/sh`,
  `/bin/bash`, `/busybox/sh`;
- `runtime-uid`: `process.getuid()` run by the image's own entrypoint;
- the token: searched in `docker history --no-trunc`, in
  `docker image inspect`, and in every layer of `docker save`, decompressed.

`DEMO_IMAGE_CONTROL=1` also builds the two wrong variants
(`docker/control/`) and measures them with the same code. That shows each
channel sees its kind of leak:

```text
$ DEMO_IMAGE_CONTROL=1 npm run demo:image
stages=4  shell-inside=0  runtime-uid=65532
token-in-history=0  token-in-config=0  token-in-layers=0
control-arg-token-in-history=2   control-arg-token-in-config=0   control-arg-token-in-layers=0
control-copy-token-in-history=0  control-copy-token-in-config=0  control-copy-token-in-layers=1
```

The ARG shows up only in history, and COPY + rm only in the layers. With
Docker's containerd image store, `image inspect` carries no history, so that
channel stays 0 even for the ARG.

### Scan gate

`npm run scan` saves the image and scans the tarball with Trivy, pinned to
`aquasec/trivy:0.76.1` and run as a container, so nothing needs installing.
It then counts the findings from the JSON report itself: severity
`CRITICAL,HIGH`, only those with a fixed version, one per
CVE + package + version. The verdict is `found <= SCAN_MAX`. `SCAN_MAX` has
no default.

```text
$ SCAN_MAX=-1 npm run scan       → critical=1 high=6 found=7 max-allowed=-1 gate=fail, exit 1
$ SCAN_MAX=99999 npm run scan    → found=7 max-allowed=99999 gate=pass, exit 0
```

All 7 come from `libssl3` in the distroless base, which we cannot fix until
Google rebuilds the base image. The first scan also found 7 in our npm tree
(`body-parser`, `brace-expansion`, `multer`). They are fixed:
- the lockfile now has fixed versions within the existing ranges;
- Nest is at 11.2.8;
- `overrides: { multer: ^2.5.0 }`, because Nest 11 still pins 2.4.0.

**Working threshold: CI runs `SCAN_MAX=10`** (`image-scan.yml`, which also
keeps the report as an artifact). That leaves room for the base image's
current findings and the daily DB updates. A new batch of fixable findings in
our own dependencies fails the build.

### Probes and shutdown

The app answers the two questions on two paths:
- **`/healthz` (liveness):** "should I be killed?" It is 200 as long as the
  event loop answers.
- **`/readyz` (readiness):** "may I get traffic?" It is 200 only after the
  warm-up and before SIGTERM.

A liveness probe on `/readyz` would turn "warming up" or "draining" into an
endless restart loop.

| Probe | Path | Settings |
| --- | --- | --- |
| startupProbe | `/healthz` | period 1 s × 60: 60 s to warm up; liveness and readiness wait for it |
| readinessProbe | `/readyz` | period 1 s, failureThreshold 1 |
| livenessProbe | `/healthz` | period 10 s × 3 |

**Warm-up.** Before `listen()` the entrypoint applies migrations, with a
Postgres advisory lock so only one pod migrates at a time. It boots Nest and
holds until at least `WARMUP_MS=4000` since start. The log shows
`ready … warmupMs=4008`. Without that gap, the broken profile would show zero
failures only because the app starts faster than it can break.

**SIGTERM, in this order:**
1. `/readyz` turns 503. From then on every response carries
   `Connection: close`, so a kept-alive client leaves the pod.
2. It keeps serving for `DRAIN_MS=5000`, while the endpoint disappears from
   kube-proxy.
3. Then `app.close()` stops accepting connections and finishes the in-flight
   requests. After `CLOSE_TIMEOUT_MS=10000` any socket still open is cut.
4. Exit 0.

`terminationGracePeriodSeconds: 30` is above drain + close (15 s), so SIGKILL
never lands mid-drain. The program refuses a grace period that is not.
Calling `close()` first would refuse new connections while the load balancer
still sends them.

**Rollout:** `maxSurge: 1`, `maxUnavailable: 0`. An old pod goes only after a
new one says it is ready. A rollout is triggered by changing the pod
template: `demo:rollout` runs `pulumi up -c rev=<ms>`, and `REV` is an env
var of the container.

**Bonus, startupProbe on numbers (from the probe settings).** Without a
startupProbe and with `initialDelaySeconds: 0`, liveness fails while the app
is not listening yet. The third failure comes about 20–30 s after start
(period 10 s × 3), and the pod restarts. A 40 s warm-up would then restart
forever. With the startupProbe, the app has 60 s (1 s × 60), and after it
passes, liveness is back to "is it alive". Raising `initialDelaySeconds`
instead would also delay detecting a real hang after every restart.

### demo:rollout: the measurement

The load generator `scripts/load.mjs` runs as a separate process:
- **Pace:** 16 workers, 300 rps in total, `GET /products?limit=5` (a real
  Postgres query) through the NodePort.
- **The file:** one response code per line. `000` means no HTTP response at
  all, the same convention as curl. There are no retries.
- **Connections:** each worker reuses its connection for 10 requests, then
  opens a new one. The Service keeps re-balancing, so a pod that is not
  listening yet gets its share, and kept-alive sockets are exercised too.
- **The count:** the demo reads the file: `requests` = lines, `ok` = `200`,
  `failed` = everything else. Then it deletes the file.

The measured window:
- the load starts once the Deployment is settled, with no terminating pods
  and 5 s of quiet;
- a 3 s baseline runs, then `pulumi up` with a new `rev`;
- the load continues until the last old pod is gone, plus 8 s.

`rollout-seconds` is the time from the new generation appearing to all
replicas updated and available, with no old ones left.

```text
$ npm run demo:rollout                    # hardened (graded)
profile=1  requests=11195  ok=11195  failed=0  no-response=0  http-5xx=0  rollout-seconds=16.1
$ DEMO_PROFILE=broken npm run demo:rollout  # control: no probes, maxUnavailable 1, no drain
profile=0  requests=4906   ok=3507   failed=1399  no-response=1399  http-5xx=0  rollout-seconds=1
```

- **Hardened is zero every time.** Four runs in a row, each right after a
  broken one: 11 195, 10 735, 10 734 and 10 946 requests, `failed=0` each
  time.
- **Broken always fails, and the share floats** (45 of 1 994, 38 of 2 013,
  1 399 of 4 906). Its connections die and hang until the 10 s timeout,
  which also cuts the request count. All failures are `000`, not 5xx: with a
  NodePort, a missing pod is a refused or dropped connection. Behind an
  Ingress the same would be 502/503.
- **Broken looks 16 times faster, and that is not a win.** Without readiness,
  a pod counts as available the moment its container starts, 4 s before it
  listens. Hardened pays for zero: no old pod leaves before a new one is
  ready, plus the drain on every pod.
- `DEMO_PROFILE=broken` restores the hardened profile when it ends.

Two lessons from getting there:
- **The client runs out of ports first.** One new connection per request at
  full speed left 16 000 sockets in `TIME_WAIT` on the Mac, and Docker
  Desktop's port forwarding started resetting connections with no rollout
  at all. Hence the pacing and the 10 requests per connection.
- **A run measures its predecessor without a settle step.** Pods that exit
  without a drain stay in kube-proxy's rules for a moment after their object
  is gone, and new connections to their IP hang. The broken profile's
  teardown showed up as 7 timeouts in the next run's baseline, until the demo
  waited for quiet first.

### PDB

`minAvailable: 2` with 3 replicas leaves one voluntary disruption, so a node
drain can proceed one pod at a time. `minAvailable == replicas` would mean
`disruptionsAllowed: 0` and block every drain. A PDB over one replica
protects nothing; the program refuses fewer than 2 replicas.

```text
$ npm run demo:pdb
healthy=3  minAvailable=2  disruptions-allowed-before=1  evict-1=201  evict-2=429  recovered=1
```

The evictions are `POST …/pods/<name>/eviction` through `kubectl proxy`, so
the codes are the API server's HTTP status. The second eviction comes before
the replacement is ready, and the budget is spent. The demo then waits until
the Deployment is whole and `disruptionsAllowed` is back to 1. A plain
`kubectl delete pod` would not be stopped at all: the budget applies only to
the Eviction API.

### HPA and `replicas`: who owns the field

The HPA is `autoscaling/v2`: min 2, max 6, CPU 70 % of the 100m request. kind
has no metrics-server, so it shows `cpu: <unknown>/70%` and scales nothing.
That is why `spec.replicas: 3` stays in the program.

In a cluster with metrics-server this becomes a field-ownership conflict.
The Pulumi program (server-side apply, field manager `pulumi-kubernetes`)
owns `spec.replicas` and writes 3 on every `up`. The HPA controller writes
the same field through the scale subresource. Say the HPA scaled to 6 under
load. The next deploy resets it to 3, the HPA scales back up a minute later,
and capacity drops in the middle of the load. With strict SSA conflict
detection, the apply fails instead.

The production fix is one owner:
- drop `replicas` from the program once an HPA exists, letting
  `minReplicas` set the floor;
- or keep it only for the first create, with
  `ignoreChanges: ["spec.replicas"]`.

### Secrets: vault → Pulumi → K8s Secret → pod

The path:
1. `npm run up` runs `scripts/with-secrets.sh dev` (Infisical; with
   `SKIP_VAULT=1`, `export`).
2. That runs `scripts/pulumi.sh up`, and the program reads the values from
   `process.env`.
3. The program creates the Secret `api-secrets`, with `data` in base64.
   Values are not wrapped in `pulumi.secret`: that stores `data` as one
   ciphertext, and a new nonce on every encrypt shows up as `~data` on
   every `up`. The passphrase still encrypts the state file as a whole.
4. The Deployment and Postgres take the values only through `secretKeyRef`.
   The manifest holds no value.

Details:
- **`data`, not `stringData`, and no `pulumi.secret()` on each value.**
  `stringData` is write-only, so every `up` would see a diff. Wrapping
  each value in `pulumi.secret()` encrypts the whole `data` map as one
  blob; the ciphertext changes on every encrypt, so every `up` shows
  `~data`. With plain base64 `data`, a second `up` is `10 unchanged`.
- **`enableSecretMutable: true` on the provider.** By default a change in a
  Secret's data replaces the Secret, and everything that references it by
  name is replaced too. For the Deployment that means delete + create, not a
  rollout. A rotation now updates the Secret in place. Pods read env at
  start, so a rotated value reaches them with the next `rev`.
- **No `pulumi refresh` on this stack.** It drops the Secret from the state,
  and the next `up` fails with `already exists`.
- **base64 is not encryption.** In this kind cluster the value sits in etcd
  in plain text, because no `EncryptionConfiguration` is set up. "Put it in a
  Secret" means "took it out of git", not "encrypted it".
- **The two secrets do different jobs, and neither replaces the other.** The
  BuildKit secret lives during `docker build`, and it keeps the image (and
  the registry) clean. The K8s Secret lives at runtime, and it keeps the
  repository clean.

**Production paths, not installed here.** External Secrets Operator syncs a
vault entry (Infisical, AWS Secrets Manager, Vault) into a K8s Secret, so
the value never passes through the deploy program or its state. The Secrets
Store CSI driver goes further: it mounts the value as a file straight from
the vault, and optionally syncs a Secret. With either one, rotation becomes
the vault's job.

---

# HW-26 — Files: presigned uploads, multipart resume, CDN without invalidation

Files (product photos, avatars, HW-15 dumps) no longer touch a server disk.
The API decides who may upload what and under which key. The bytes go from
the client straight into S3-compatible storage. Public assets are served by
a cache in front of a private bucket.

## Files

### Pieces

| Piece | Where |
| --- | --- |
| `files` table (key, owner_id, status, size, upload_id, part_size, part_count, etag, idempotency_key) | `src/migrations/1726700000000-Files.ts` |
| intent / resume / commit / download | `src/files/files.service.ts`, `files.controller.ts` |
| allowlist, TTLs, threshold, part size, magic bytes | `src/files/policy.ts` |
| the only S3 client (presign, HeadObject, ListParts, Complete, purge) | `src/storage/storage.ts` |
| CDN edge (local CloudFront + OAC stand-in) | `src/cdn/edge.ts`, run with `npm run edge` |
| content-hashed asset publishing | `src/cdn/assets.ts` |
| emulator | `storage` in `docker-compose.yml`: MinIO, `:22650`, tmpfs `size=1g` |

The emulator is `pgsty/minio`, pinned to `RELEASE.2026-08-04T00-00-00Z`. That
is a maintained community build of MinIO. Docker Hub and quay.io no longer
serve `minio/minio`. The data lives in tmpfs, so `docker compose down` leaves
a clean slate. The `1g` size keeps a demo series from running out of space.

### Variables

| Змінна | Джерело | Навіщо |
| --- | --- | --- |
| `STORAGE_ACCESS_KEY` | vault (#11) | storage access key: read and write every file in the bucket |
| `STORAGE_SECRET_KEY` | vault (#11) | its secret |
| `STORAGE_ENDPOINT` | compose / оточення | `http://127.0.0.1:22650` for MinIO; empty means AWS S3 |
| `STORAGE_REGION` | compose / оточення | `us-east-1` unless set |
| `STORAGE_BUCKET` | compose / оточення | `hw26-files`; not a secret |
| `EDGE_PORT` | оточення | port of `npm run edge` (8088) |

The HW-24 auth variables (`JWT_*`, `REFRESH_TOKEN_PEPPER`) are still
required, because `intent` and `commit` sit behind the same `AuthGuard`. The
demos go through `scripts/with-secrets.sh dev`, like everything else. To use
the vault, add `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` to the `dev`
environment in Infisical. `npm run start` refuses to boot without the storage
variables and names the missing ones. Tests and the older demos boot
`AppModule` directly. Without storage they simply have no file endpoints.

The leak cost differs from `DATABASE_URL`. A leaked storage key can read and
write every file without touching our network. In production the app runs
under a role scoped to this bucket, not a long-lived key.

### The upload contract

1. `POST /uploads/intent` `{contentType, size, filename?}` sits behind the
   HW-24 `AuthGuard`. `contentType` must be in the allowlist (PNG, JPEG,
   WebP, PDF, gzip), or the answer is 415. Each type has its own size cap,
   and above it the answer is 413.
   - The server builds the key as `uploads/{userId}/{uuid}.{ext}`. The
     extension comes from the allowlist. `filename` is accepted and ignored,
     so `../../etc/passwd` never reaches the key.
   - A `PENDING` row is inserted. An `Idempotency-Key` header (HW-22) makes a
     double tap return the same file with fresh URLs instead of a second
     object.
2. The client `PUT`s the bytes to the presigned URL. Our process is not on
   that path. The signature covers the key, `Content-Type` and
   `Content-Length`. Another key in the path is 403 (`tampered`), and so is
   the right key with more bytes than declared (`oversized-put`). Storage
   enforces the size before commit ever sees the object. Part URLs sign
   their exact part length the same way.
3. `POST /uploads/:id/commit` checks the object, not the client's claim:
   - `HeadObject` must find it, or the answer is 409.
   - Its size must equal the declared size, or the object is deleted and
     the answer is 409.
   - Its first 16 bytes must match the declared type, or the object is
     deleted and the answer is 422. `Content-Type` is the client's word;
     the magic bytes are the file's.

   Only then does the row become `COMPLETED`. Someone else's file is 403
   (checked on the loaded row, as in HW-24).
4. `GET /files/:id` answers 302 to a presigned GET that lives 60 seconds.
   Nobody gets a long-lived download link. The guard runs on every request,
   so the API stays on the authorization path but off the data path.

The S3 client is created with `requestChecksumCalculation: 'WHEN_REQUIRED'`.
Otherwise a presigned PUT, signed before any body exists, would carry the
CRC32 of empty data. Logs carry `file_id` and the key, never a URL: a
presigned URL in a log line is access handed out until it expires.

### How long presigned URLs live

| URL | TTL | Why |
| --- | --- | --- |
| single PUT | 5 min | an avatar or product-photo form uploads right after intent. A single PUT is at most 8 MiB (above that it is multipart), about a minute at 1 Mbit/s, so 5 minutes leaves room for one retry and a slow start |
| multipart part | 15 min | one part (5 MiB and up), not the whole file; a resume asks for fresh URLs, so a long upload never needs a long URL |
| download (302) | 60 s | the browser follows the redirect at once |

A presigned URL cannot be revoked. It has no `jti` and no registry, so of the
HW-24 revocation strategies only "short" works. Also, `expiresIn: 7 days`
does not survive production. A URL dies with the credentials that signed it,
and a role session (STS) usually lasts an hour.

`expired=403` in the demo uses the same `Storage.presignPut` the API calls,
with a 2-second TTL. The same URL gives 200 while it is fresh and 403 after,
so the demo does not wait five minutes. The demo accepts any 4xx there (and
for `tampered` and `oversized-put`): S3 and MinIO refuse a bad or expired
signature with 403, some other S3-compatible stores with 400.

### Multipart: threshold, part size, resume

- **Threshold is computed:** `multipartThreshold()` in `src/files/policy.ts`.
  It answers: how much can a dropped single PUT cost to redo from zero?
  - The budget is 64 s on the slowest link we design for: a 1 Mbit/s
    mobile uplink, about 128 KiB/s.
  - That gives 64 × 128 KiB = **8 MiB**, which is also the AWS CLI default
    (`multipart_threshold = 8MB`).
  - The result is never below two minimum parts (5 MiB + 1 MiB). Otherwise a
    "multipart" file would be one part plus a stub, and resume would gain
    nothing.
- **Part size is computed:** `max(5 MiB, ceil(size / 10 000) rounded up to
  a MiB)`. At most 10,000 parts, each 5 MiB to 5 GiB except the last. A
  fixed 5 MiB fails above about 48.8 GiB; the computed size gives 6 MiB at
  50 GiB and 525 MiB at 5 TiB (`test/unit/files-policy.spec.ts`).
- **Resume:** `POST /uploads/:id/resume` asks the storage with `ListParts`
  which parts it already has. It returns fresh URLs only for the missing
  ones. The new process has no memory of the old one, and needs none. If
  the upload was already aborted, by the orphan sweep or the lifecycle
  rule, the answer is 410, and the client starts a new intent.
- **Commit:** `CompleteMultipartUpload` uses the part list from `ListParts`,
  not from the client. Each part's size is checked against the plan first,
  so a wrong part is a 409 rather than `EntityTooSmall`. A second,
  concurrent commit finds the upload already completed and falls through to
  `HeadObject`, so it does not fail with a 500.

Size is only one of the four multipart benefits in the S3 docs. The others
are faster upload through parallel parts, pause and resume, and starting
before the final size is known. This demo is about resume.

A multipart ETag is not an MD5. It is the MD5 of the parts' MD5s, plus `-N`
for the number of parts. Code that compares it with a local MD5 breaks
silently.

### CDN: which form, and the AWS policy

**Local form.** `src/cdn/edge.ts` is about 60 lines of logic:
- It reads the private bucket with its own credentials, through the same
  SDK client, and keeps an LRU in memory.
- The LRU is bounded by **bytes**, not entries: 64 MiB of bodies in total
  (`EDGE_MAX_BYTES`), least recently used evicted first. An object above
  10 MiB is served but not cached, so one large file cannot flush the rest.
  A count limit would have allowed 1000 × 10 MiB ≈ 10 GiB.
- It answers `GET` and `HEAD` (`curl -sSI` gets the headers and
  `Content-Length` from the cache), and `304` with no body when
  `If-None-Match` matches the ETag. Other methods are `405`.
- It answers with `X-Cache: HIT|MISS`.
- It coalesces concurrent misses into one origin fetch.
- It serves `assets/` only; user uploads never go through it.
- It answers 400 to a malformed path.

That is the OAC idea: the cache reaches storage, the public reaches the
cache. The bucket has no policy at all, so an anonymous GET straight at
storage is 403. Locally the edge reuses the app's storage key. In
production it gets its own identity, allowed only `s3:GetObject` on
`assets/*`, which is what the OAC policy below grants CloudFront.

What the edge caches, and for how long, comes from the object's own
`Cache-Control`. `publishAsset` sets that header when it uploads the asset:
`public, max-age=31536000, immutable`. An object uploaded without it is
never cached (`no-cache-control-hit=0` in the demo).

**AWS form:** CloudFront with Origin Access Control and this bucket policy.
The `AWS:SourceArn` condition is what limits access to *this* distribution;
without it, any CloudFront distribution in the world could read the bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOACReadAssets",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::hw26-files/assets/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE"
        }
      }
    }
  ]
}
```

Leave Block Public Access on. This is a service-principal grant, not a
public one. For private content (paid downloads), the plan is CloudFront
signed URLs or signed cookies. The signing key goes in the vault, because
whoever holds it can grant access to everything in the distribution.

### Updates without invalidation

A deploy publishes `app.css` as `assets/app.<sha256[0..8]>.css`. New content
gets a new name, the HTML points at the new URL, and the old cache entry is
never asked for again. Nothing is invalidated. AWS itself recommends
versioned file names over invalidation for files that change often.
`old-url-still-hit=1` shows the old entry is still in the cache and harms
nobody.

### Hygiene: orphans and unfinished uploads

- **Orphan files.** An intent that is never committed leaves a `PENDING`
  row, and maybe an object or unfinished parts. `src/files/orphans.ts`
  sweeps `PENDING` rows older than a day, using the partial index
  `idx_files_pending_created_at`:
  - `AbortMultipartUpload`, then `DeleteObject`, then delete the row.
  - Storage goes first and the row last, so a crash in between is retried
    on the next sweep.
  - `FOR UPDATE SKIP LOCKED` lets two workers share the work.

  It runs as the BullMQ scheduler `files-orphan-sweep`, hourly, in the HW-23
  worker (`npm run worker`) when storage is configured. `demo:upload` ages
  its never-committed intent by two days, runs the sweep, and prints
  `orphan-swept=1`.
- **Unfinished multipart uploads are billed** although no object exists and
  the console does not show them. On AWS the fix is the lifecycle rule
  `AbortIncompleteMultipartUpload: 7 days`. `npm run storage:setup` tries to
  install it. MinIO rejects that rule (`InvalidArgument`) and instead cleans
  stale uploads itself (`stale_uploads_expiry=24h`), so the script prints
  `abort-incomplete-multipart-rule=0` locally. "Delete everything older than
  30 days" does not touch these uploads; it is a different action.
- **The list of a user's files is the `files` table,** not a bucket listing.
  A listing is paid and slow, at 1,000 keys per call.
- **Backups (HW-15).** Their destination is now this bucket, and lifecycle
  makes it cheap. Two caveats: Glacier breaks the RTO, because the object
  must be restored first, and lifecycle does not verify a backup. The
  restore drill stays.

### Demos, from my runs

Each demo cleans its own state first:
- `ListMultipartUploads` → `AbortMultipartUpload` and delete for its users'
  prefixes, or `assets/` for `demo:cdn`;
- then the users, whose `files` rows are deleted with them.

Upload and resume are done by child processes whose environment is only
`PATH`. They print `env-keys=0` themselves. A demo kills any child still
running when it exits, the Node version of `trap … EXIT`. The API and the
edge listen on port 0, so every run gets its own free port and a second run
never hits `EADDRINUSE`.

```text
$ npm run demo:upload
intent=200  key-from-server=1  intent-idempotent=1  put-ttl-sec=300
tampered=403  oversized-put=403  commit-without-bytes=409
api-alive=0  put-env-keys=0  put-offline=200
foreign-commit=403  commit=200  status-completed=1
download=302  download-body-match=1  expiry-probe-fresh=200  expired=403
orphan-swept=1

$ npm run demo:multipart        # same numbers on the second run
file-bytes=12582912  part-size-mib=5  parts=3  intent=200  uploader-env-keys=0
first-process-killed=1  parts-before-crash=2  head-before-complete=404
resumed-parts=1  complete=200  size-match=1  etag-multipart=1

$ npm run demo:cdn
direct=403  edge-miss=200  edge-miss-x-cache-miss=1  edge-hit=200  cache-hit=1
cache-control-immutable=1  edge-head=200  head-x-cache-hit=1  head-body-bytes=0
head-content-length-match=1  revalidate=304  revalidate-body-bytes=0
no-cache-control-hit=0  new-name=1  new-url=200  content-changed=1  old-url-still-hit=1
invalidations=0  origin-fetches=4
```

What the main lines prove:
- `demo:upload`:
  - `api-alive=0` with `put-offline=200`: the API was closed (a raw TCP
    probe confirms it), and a keyless process still got the bytes in.
  - `tampered=403`: the same signature with another key in the path fails,
    so the signature covers the path.
  - After the PUT, the API comes back on a different port, because a pooled
    socket to the old port would be dead.
- `demo:multipart`: process A is killed with SIGKILL after two parts.
  Process B uploads only the third. Before Complete, `HeadObject` is 404
  even though two parts are stored.
- `demo:cdn`: `origin-fetches=4` breaks down as follows. `v1` was fetched
  once and then served from the cache four times: a GET, a `HEAD`, a
  conditional GET answered `304`, and the old-URL read after the deploy. The
  object without `Cache-Control` was fetched both times. `v2` was fetched
  once.

---

# HW-24 — Auth: access tokens, refresh rotation, 401 vs 403

`POST /orders` no longer accepts a caller-supplied user. Login gives an ES256
access token and an opaque refresh token. The access token answers "who is
this?". A role or an order's owner answers "are they allowed?", and that
answer is not in the signature.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`, `hw-19/`, `hw-22/`, `hw-23/`.

## Auth

### What I chose

**ES256 (P-256).** OWASP marks RS256 as "not recommended" and points at ES256,
PS256 or EdDSA. P-256 is in `node:crypto`, the keys and signatures are short,
and verification passes an explicit allowlist `algorithms: ['ES256']`
(RFC 8725 §3.1). A token cannot switch itself to `HS256` or `none`. There is
no shared HMAC secret, so the process that verifies tokens cannot sign itself
a `role: admin`.

**Refresh tokens are random 32-byte strings, not JWTs.** The table stores
`HMAC-SHA256(pepper, token)`, never the token. The pepper is `REFRESH_TOKEN_PEPPER`
from the vault. A dump of the table is not a dump of live sessions.

**The denylist is in Postgres, next to the refresh family, in one transaction.**
Redis from HW-23 is still the cache, the session store, the rate limiter and
the queue. It is not the denylist: writing `revoked_at` in Postgres and the
denylist in Redis would be the dual write from HW-22, and logout would not be
one COMMIT. The grader also does not set `REDIS_URL`.

**Revocation is per family, not per `jti`.** Every access token carries `fid`.
`revoked_families` holds a revoked family for `ACCESS_TTL` (10 minutes), the
longest any access token of it can still live. `authenticate` checks `fid`
there and `jti` in `access_denylist` in one query.

**Nothing grows forever.** Login and logout sweep expired rows from
`refresh_tokens`, `access_denylist` and `revoked_families`, using the
`expires_at` index on each table. Each sweep deletes at most 500 rows per
table with `FOR UPDATE SKIP LOCKED`, so concurrent logins do not queue
behind each other. An expired refresh token is rejected by `expires_at`
anyway, so deleting its row loses nothing.

### Variables

| Змінна | Джерело | Навіщо |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` | vault (#11) | base64 PKCS#8 PEM, signs access tokens |
| `JWT_PUBLIC_KEY` | vault (#11) | base64 SPKI PEM of the current `kid` |
| `JWT_KID` | vault (#11) | `kid` header; the verifier picks the key by it |
| `JWT_PUBLIC_KEYS` | vault (#11) | optional JSON `{"old-kid":"<base64 PEM>"}` kept during overlap |
| `REFRESH_TOKEN_PEPPER` | vault (#11) | HMAC pepper for refresh-token hashes |
| `DATABASE_URL` | compose / оточення | dev credentials, not a secret |
| `REDIS_URL` | compose / оточення | cache (`allkeys-lru`) |
| `REDIS_QUEUE_URL` | compose / оточення | queue, sessions, rate limits (`noeviction`) |

`npm run start` is a bare `node dist/src/main.js`. It checks these four required
secrets before Nest opens a database connection, and exits non-zero naming
whatever is missing. There is no default. It also rejects a key that is not
EC P-256, and a private/public pair that does not match (it signs a probe and
verifies it). A mismatched pair would otherwise boot and answer 401 to
everyone. `npm run start:vault` and
`demo:auth`, `demo:reuse`, `demo:rbac` go through `scripts/with-secrets.sh`.

### Login, rotation, reuse

`POST /auth/login` checks the password (scrypt) and reads `users.role` from
the database. It returns an access token (10 minutes: `sub`, `role`, `jti`,
`fid`, `kid`) and a refresh token (30 days) in a new `family_id`.

`POST /auth/refresh` locks that row (`FOR UPDATE`) and, in the same
transaction, marks it used and inserts the next token of the same family.
The new access token's role is read from `users` again, not copied out of the
old token.

If the presented refresh token already has `used_at`, that is the theft
signal from RFC 9700 §4.14.2. The transaction sets `revoked_at` on every row
of the family and puts the family into `revoked_families`. The log line is
`refresh token reuse; family revoked family_id=…` (the id only, never the
token). Both the thief and the honest client are out, refresh and access
alike. `a1-after-reuse=401` and `a2-after-reuse=401` show the access side:
the thief does not get to keep the 10 minutes left on their access token.
Rotation without the family would leave the honest client's new token alive.

There is no grace window. The client serializes refresh: one in-flight promise
for everyone. A window that handed back the same new pair would make an
immediate second presentation look successful, and a parallel refresh of one
token is treated as theft. That is the tradeoff, and it is why `r1-reuse` is
401 with no delay.

### Why logout is two actions

The refresh token is a row. Logout sets `revoked_at` on its family, and that
is enough for it. Access tokens are self-contained and valid until `exp`, so
logout also denylists them. That means the family (`fid` into
`revoked_families`, covering every access token of this login) and the
presented `jti` (`access_denylist`, `expires_at` = its `exp`). Everything
commits together. A `jti`-only denylist is not enough: the access token
issued before the last refresh has a different `jti` and would still answer
200. `old-access-after-logout=401` is that case. `refresh-after-logout=401`
is the refresh family. Either action alone leaves a usable credential.

### 401, 403, and where ownership is checked

No token, a bad signature, an expired token, or a revoked `fid`/`jti` is **401**.
A valid token with the wrong role is **403** (`RolesGuard` on `POST /products`:
`seller` and `admin` only). A client refreshes on 401 and shows an error on
403. Swapping them either loops on refresh or logs the user out on every
foreign page.

Ownership is not a guard. `AuthGuard` runs before the order is loaded and does
not know `user_id`. `GET /orders/:id` loads the row in `OrdersService.findOneForViewer`
and then compares `order.userId` to `sub`. A missing order is 404. Someone
else's order is 403. A `WHERE user_id = $me` would hide the row and answer
404, which is not what this check is for. The guard authenticates. The service,
which already has the row, authorizes.

In this domain, orders are the owned resource and products are the privileged
write. The same boundary covers every way into an order:

- `GET /orders` is a list, so there the filter *is* `WHERE user_id = $me`.
  An admin sees all orders.
- `PATCH /orders/:id/status`: the owner may only set `cancelled`, and any
  other status is 403. An admin may set any status.
- SSE `GET /orders/:id/events` and the WebSocket `join` authenticate with the
  same access token. The WebSocket token goes in the handshake as
  `auth.token`. SSE takes the `Authorization` header, or `?access_token=` because
  `EventSource` cannot set headers. Then they call the same
  `OrdersService.requireOwner`. The old `x-user-id` and `userId` in the message
  body are gone. `scripts/realtime-demo.mjs` needs `ACCESS_TOKEN`.
- `POST /session` (HW-23) is behind `AuthGuard` and takes the user from `sub`.

Seed users have no password, so they cannot log in. Demos and tests create
their own users.

### The role in the token is a cache

`users.role` is read at login and at refresh. It is not read on every request.
Demote an admin and their current access token still says `admin` until `exp`,
at most 10 minutes. The next refresh picks up the new role. That window is the
price of not hitting the database on every call. It is not a surprise, and it
is not fixed by a longer denylist.

### Overlap rotation and `kid`

A new key signs new tokens: `JWT_KID` plus `JWT_PRIVATE_KEY`. While old access
tokens are still inside their 10 minutes, `JWT_PUBLIC_KEYS` keeps the previous
public key under its own `kid`. The verifier looks up `header.kid` and does
not try every key. Without `kid` there is no overlap, because the verifier
would not know which key signed the token. When the old tokens have expired,
drop the old `kid`. Startup logs `auth signing kid=… fingerprint=…` and never
the key.

The fingerprint is SHA-256 of the SPKI DER, first 16 hex characters. Dev and
prod are different keys:

| Environment | kid | fingerprint |
| --- | --- | --- |
| dev | `dev-2026-10` | `cc5b95404c60a21a` |
| prod | `prod-2026-10` | `3a78e84114c26196` |

The private keys are not in the repo. They are in `secrets/auth-dev.env` and
`secrets/auth-prod.env` (gitignored) to be copied into the vault. `secrets/auth.env.example`
shows the names only.

### Demos, from my runs

```text
$ npm run demo:auth
login=200  no-token=401  with-token=200  refresh=200
logout=204  after-logout=401  old-access-after-logout=401
refresh-after-logout=401  expired-refresh-swept=1

$ npm run demo:reuse
login=200  r1-refresh=200  a2-before-reuse=200  r1-reuse=401
r2-after-reuse=401  a1-after-reuse=401  a2-after-reuse=401

$ npm run demo:rbac
anon=401  own=200  foreign=403
role-denied=403  role-allowed=201  tampered=401
```

`tampered` is the same access token with `role` rewritten to `admin` and the
old signature left in place. No signing key is used to build it. A verifier
that only decoded the payload would return 201 here.

The same invariants run in `npm run test:e2e` (`Auth E2E`): family revocation
on reuse (refresh and access), logout killing every access token of the login
while another login of the same user keeps working, the sweep of expired
refresh rows, 401/403/200 on an order, the list
scoped to the caller, a buyer cancelling but not completing, and the role
check on products. Tests and the HW-22/23 demos that do not exercise auth
get a throwaway key pair from `src/demos/ephemeral-auth.ts`, and only when
the variables are unset. `main.ts` never generates keys.

---

# HW-23 — Redis: cache, sessions, rate limits, queue

Redis takes four jobs in the Marketplace: a cache for the product card, the
session store, a shared rate limiter, and a BullMQ queue for receipts and the
outbox retention sweep. Postgres stays the source of truth for everything.

## Redis: кеш, сесії, ліміти, черга

### Pieces

| Piece | Where |
| --- | --- |
| Two Redis clients (cache / state+queue), fail-fast options | `src/redis/clients.ts` |
| Lock: `SET lock:… token NX PX`, Lua compare-and-delete release | `src/redis/lock.ts` |
| Cache-aside + single-flight + TTL jitter + negative cache | `src/redis/single-flight-cache.ts` |
| Heavy read: product card with sales aggregates, `GET /products/:id/card` | `src/products/product-card.ts`, `product-card.controller.ts` |
| Sessions with rolling TTL, `POST/GET/DELETE /session` | `src/session/*` |
| Sliding-window limiter (one Lua script), Nest guard with 429 + `Retry-After` | `src/rate-limit/*` |
| BullMQ queue `receipts`: `send-receipt` jobs + `outbox-purge` scheduler | `src/queue/receipts.queue.ts`, worker `src/queue/worker-main.ts` |
| Demos | `src/demos/demo-{cache,session,ratelimit,queue}.ts` |

The Redis module is loaded only when both `REDIS_URL` and `REDIS_QUEUE_URL`
are set, so integration/e2e/contract tests keep running without Redis.

### Two instances, and why

| | `redis-cache` (`:6390`) | `redis-queue` (`:6391`) |
| --- | --- | --- |
| Policy | `maxmemory 64mb`, `allkeys-lru` | `maxmemory 256mb`, `noeviction` |
| Persistence | none (`--save ""`, no AOF) | AOF, `appendfsync everysec`, volume `redis_queue_data` |
| Holds | `product:card:*`, `lock:product:card:*` | BullMQ `bull:*`, `session:*`, `rl:*` |

**Why two:** a cache must be allowed to evict under memory pressure, while
eviction in a queue silently deletes jobs (and BullMQ's own locks), so one
instance cannot have both policies. With `noeviction` a full queue Redis fails
writes loudly instead of losing data.

**Sessions live in the queue instance**, not the cache one: under `allkeys-lru`
a busy cache would log users out by evicting their sessions, and the cache has
no persistence, so a Redis restart would drop every session. The `noeviction`
+ AOF instance keeps them across restarts of both the app and Redis. Rate-limit
counters sit there too: evicting a counter would reset someone's limit.

### 1. Cache-aside on the product card

`GET /products/:id/card` returns the product plus `units_sold`,
`orders_count`, `revenue_cents`, `last_ordered_at`: an aggregate over
`order_items` ⋈ `orders`. That's the heavy read. Key `product:card:{id}`.

- **TTL always, with jitter:** `300 + random(0..60)` s (negative results
  `30 + random(0..15)` s, so a hammered non-existent id does not hit the DB on every request).
- **Single-flight:** on a miss, `SET lock:product:card:{id} <uuid> NX PX 5000`.
  The winner re-checks the cache, reads the DB, writes the value, and releases
  the lock with a Lua `GET == token → DEL` so it never deletes a lock that
  expired and was taken by someone else. Losers poll the key every 25 ms **for
  as long as the lock exists**. There's no separate wall-clock timeout, because
  a timeout shorter than the lock TTL would send every waiter to the DB on a
  slow read. If the lock disappears without a value (holder crashed, load
  failed, or 5 s passed), the next `SET NX` elects exactly one new loader.
- **Redis down = slower, not broken:** a failed read goes straight to the DB, a
  failed write is ignored. Redis is never the source of truth.
- **Stale stock is accepted:** stock on the card can lag by up to one TTL.
  Checkout re-checks stock in Postgres under a lock, so a stale card can show
  a wrong number but can't oversell.

### 2. Sessions with rolling TTL

`POST /session` creates a random 32-byte `sid` (cookie `sid`, `HttpOnly`,
`SameSite=Lax`, `Secure`) and a hash `session:{sha256(sid)}` (the raw token is never a
key). Every request with the cookie runs one Lua script: `EXISTS` → `HINCRBY
requests` → `HSET lastSeenAt` → `PEXPIRE 30 min` → `HGETALL`. The TTL is pushed
forward atomically, and an expired session is never resurrected. Login rotates
the session; `DELETE /session` deletes the key.

`Secure` is left out only for plain HTTP to `localhost` / `127.0.0.1` / `::1`
(the local stand). Behind a TLS-terminating proxy the app sees
`X-Forwarded-Proto: https` from a trusted hop and sets `Secure`. Plain HTTP to
any other host also gets `Secure`, so the browser won't send `sid` over an
unencrypted connection.

### 3. Rate limit: sliding window log

**Model:** sliding window log. Of the models I looked at, it's the only one
with no boundary burst: a fixed window lets `2 × limit` through around the edge
of the window. The cost is one sorted-set entry per request, which is fine at
60 req/min.

One Lua script per request: `TIME` (Redis clock, so pods' clocks don't matter)
→ `ZREMRANGEBYSCORE` old entries → `ZCARD` → `ZADD` if under the limit →
`PEXPIRE`. When blocked, it returns how long until the oldest entry leaves the
window. The guard answers `429` with `Retry-After` (seconds, at least 1) plus
`RateLimit-Limit` / `RateLimit-Remaining`. Key `rl:{route}:{ip}`, so all pods
share it.

`{ip}` is `req.ip`, which depends on Express `trust proxy` (set in
`src/configure-app.ts`). Without it, behind an ingress every client has the
proxy's address and shares one window. With `true`, any client could forge
`X-Forwarded-For` and get a fresh window per request. The default is
`loopback, linklocal, uniquelocal`, so `X-Forwarded-For` is trusted only from
proxies on private networks. `TRUST_PROXY` overrides it (hop count, `true`/`false`,
or a list of subnets) for setups where the proxy has a public address.

If Redis is down the guard fails open (logs and lets the request
through) because the limiter protects the DB, it isn't a security boundary.
Config: `RATE_LIMIT_LIMIT` (60) and `RATE_LIMIT_WINDOW_MS` (60000).

### 4. BullMQ queue `receipts`

- **Producer:** the HW-22 `order.placed` consumer, after the effect commits and
  before ack, adds `send-receipt` with `jobId = receipt-{orderId}`. A redelivered
  event adds the same jobId, so BullMQ keeps one job. If Redis is unavailable
  the message is requeued like a transient DB error.
- **Options:** `attempts: 5`, `backoff: { type: 'exponential', delay: 1000,
  jitter: 0.5 }`, `removeOnComplete: { age: 86400, count: 10000 }` (not
  `true`: a completed job must stay long enough to dedup a late duplicate),
  `removeOnFail: { age: 7 days }`.
- **Scheduler:** `queue.upsertJobScheduler('outbox-purge', { every: 10 min })`.
  It replaces the `setInterval` the HW-22 relay used for retention. Upsert is
  idempotent, so every worker start (or several workers) still leaves one
  scheduler. `npm run worker` runs it.
- Worker connection uses `maxRetriesPerRequest: null` (BullMQ requirement);
  producer connections fail fast so an HTTP request or consumer never hangs on Redis.

### Demos and numbers from my runs

Each demo resets only its own keys (`SCAN`, never `KEYS`), prints
`key=number`, and ends with `invariant-ok=1`, or exits 1 if a check fails.

```text
$ npm run demo:cache
cache-lru=1  cache-maxmemory=1  cache-maxmemory-mb=64
warmed=60  ttl-distinct=36  ttl-min=300  ttl-max=360
concurrent=50  all-served=1  db-calls=1  lock-left=0
slow-load-ms=3500  slow-db-calls=1  slow-all-served=1
warm-reads=100  db-calls-warm=0

$ npm run demo:session
requests=3  sessions=1  sessions-in-redis=1  in-redis=1
ttl-before-ms=1798491  ttl-after-ms=1799996  ttl-renewed=1
survived-restart=1  server-requests=3
cookie-secure-local=0  cookie-secure-behind-tls-proxy=1

$ npm run demo:ratelimit
instances=2  limit=5  window-ms=10000  requests=12
allowed=5  blocked=7  allowed-pod-a=3  allowed-pod-b=2
status=429  retry-after=1  retry-after-seconds=10
proxied-clients-separate=1

$ npm run demo:queue
queue-noeviction=1  attempts=3  fail-times=2  completed=1
added=2  queued=1  same-job-id=1  readd-after-complete-deduped=1
schedulers=1  scheduler-upserts=2  scheduled-runs=7
```

(Each value prints on its own line; they're grouped here to save space.)

- **cache:** `cache-lru` / `cache-maxmemory` come from `CONFIG GET` on the cache
  connection at runtime. `db-calls` is counted at the driver by a TypeORM
  logger that matches the `/* product-card */` SQL tag. Out of 50 concurrent
  requests for a just-expired key, 1 reached Postgres; 100 warm reads, 0.
  The second stampede makes the DB read take 3.5 s (longer than a typical fixed
  wait, shorter than the 5 s lock). The 49 waiters kept waiting on the lock, and
  still only 1 query reached Postgres (`slow-db-calls=1`).
- **session:** 1.5 s pause between requests 1 and 2; PTTL went from 1798491 ms
  to 1799996 ms. Then the Nest app was closed and a new one booted, and request
  3 got the same session (`requests=3` counted server-side). The local cookie
  has no `Secure`; the same app behind `X-Forwarded-Proto: https` sets it.
- **ratelimit:** two separate Nest apps on two ports, requests alternated, limit 5
  per 10 s. Exactly 5 got through in total (3 + 2), not 5 per pod. After that
  the direct client is blocked, yet two clients coming through a trusted proxy
  (`X-Forwarded-For: 203.0.113.10` / `.11`) still got 200 each: separate windows,
  not the proxy's shared one.
- **queue:** queue `receipts-demo` (same code, isolated name). The job fails
  twice on purpose and succeeds on the 3rd attempt. Two adds with one jobId
  gave one job; re-adding after completion did not run it again. The scheduler
  was upserted twice (500 ms interval) and is still one; it fired 7 times in about 3 s.

### If the stampede lock breaks

The lock has a 5 s TTL. If the DB read is slower than that, or Redis loses the
lock key, two requests will both read Postgres and both write the card. The
result is a few extra reads of one aggregate and two writes of practically the
same value (last write wins, both carry a fresh TTL). That's acceptable here
because the cache is only an optimisation. No decision is made from it: stock
and prices are checked again in Postgres at checkout, so the worst case is a
short DB load spike, not a wrong order. Release by token makes sure a slow
holder never deletes someone else's lock. If the protected section ever did
writes that must not run twice, this lock would not be enough. It would need a
fencing token checked by the DB (or a real DB lock).

### Secrets

No new env files. `REDIS_URL` and `REDIS_QUEUE_URL` go into the same Infisical
project/environment (`dev`) that already holds `DATABASE_URL`. All new scripts
(`demo:cache`, `demo:session`, `demo:ratelimit`, `demo:queue`, `worker`) start
with `bash scripts/with-secrets.sh dev …`. `.env.example` only lists the
variables with local placeholders.

---

# HW-22 — Transactional outbox and idempotency

Placing an order (`POST /orders`) now tells the outside world about it without a
dual write. The order rows, the `Idempotency-Key` claim and the `order.placed`
outbox row commit in one Postgres transaction. A separate relay moves the
outbox to RabbitMQ. The consumer applies the effect idempotently.

## Outbox та ідемпотентність

### Pieces

| Piece | Where |
| --- | --- |
| Migration: `outbox`, partial index `WHERE published_at IS NULL`, `processed_messages`, `order_confirmations` | `src/migrations/1726300000000-OutboxAndInbox.ts` |
| Migration: `outbox.last_error`, retention indexes on `published_at` / `processed_at` | `src/migrations/1726400000000-OutboxRetryAndRetention.ts` |
| Retention sweep (batched `DELETE`) | `src/outbox/retention.ts`, one-shot `src/outbox/purge-main.ts` |
| Business operation: order + items + idempotency claim + outbox row in one `dataSource.transaction` | `src/orders/place-order.ts` |
| Event contract (`toOrderPlacedEvent`), not the ORM entity | `src/outbox/order-placed.event.ts` |
| Relay: `FOR UPDATE SKIP LOCKED` → publish (confirm channel) → `UPDATE published_at` | `src/outbox/relay.ts`, worker `src/outbox/relay-main.ts` |
| Idempotent consumer | `src/outbox/consumer.ts`, worker `src/outbox/consumer-main.ts` |
| Demos | `src/demos/demo-*.ts` |

The broker is RabbitMQ from `docker-compose.yml`: a separate process from
Postgres, so there really are two resource managers and no shared COMMIT.

Outbox columns follow the Debezium Outbox Event Router roles: `id`,
`aggregate_type`, `aggregate_id`, `type`, `payload jsonb`, plus `created_at`,
`published_at` (NULL = not relayed yet), `attempts` and `last_error`. Debezium's canonical
names are `aggregatetype` / `aggregateid`, so moving to CDC means setting
`route.by.field=aggregate_type` and `table.field.event.key=aggregate_id` (or
renaming the columns). Consumers do not change.

### Three levels of idempotency

1. **Natural key (effect).** The effect is "record an order confirmation":
   `INSERT INTO order_confirmations … ON CONFLICT (order_id) DO NOTHING`.
   Repeating it changes nothing, unlike `qty = qty - 1`.
2. **Inbox.** `INSERT INTO processed_messages (message_id, consumer) … ON
   CONFLICT DO NOTHING` and the effect run in **one** transaction on one pooled
   client. If the mark already exists, the transaction rolls back and the
   message is acked as a duplicate. Mark and effect commit or vanish together.
   Putting the mark in Redis would be a dual write again.
3. **API edge.** `Idempotency-Key` header on `POST /orders`. The key is claimed
   with `INSERT INTO idempotency_records … ON CONFLICT DO NOTHING` inside the
   order transaction. If another request already claimed it, this transaction
   rolls back (stock included) and the stored response is returned with
   `Idempotent-Replayed: true`. Concurrent requests serialize on the unique key.
   The key identifies the **intent**. The body hash is stored only to reject
   reuse of one key for a different body (422). Two identical orders with
   different keys are two orders.

### Demos and numbers from my runs

All three reset their own state first: run migrations, upsert a demo user and
product (id 9001), delete that user's orders, truncate `outbox`,
`processed_messages`, `order_confirmations`, and recreate the queues. Each
prints `key=number` and exits non-zero when its invariant breaks.

| Demo | What happens | Output |
| --- | --- | --- |
| `demo:outbox` | Boots the Nest app, sends two **concurrent** `POST /orders` with the same `Idempotency-Key`, relays, consumes | `requests=2` `same-order=1` `replayed=1` `orders=1` `outbox=1` `published=1` `deliveries=1` `effect=1` `processed=1` |
| `demo:crash-write` | The order transaction throws right after the outbox insert (the row was visible inside the tx: `outbox-in-tx=1`) | `write-failed=1` `orders=0` `outbox=0` `published=0` `deliveries=0` `effect=0` `stock-unchanged=1` |
| `demo:crash-relay` | A child relay process is killed between broker confirm and `UPDATE published_at`; a second relay runs | `relay-killed=1` `unpublished-after-crash=1` `published=2` `deliveries=2` `applied=1` `skipped=1` `effect=1` `processed=1` `outbox-published=1` |

**How the relay is killed.** `demo:crash-relay` spawns `relay-main.js` as a real
child process with `RELAY_CRASH_AFTER_PUBLISH=1`. After the broker confirms
the publish and before the `UPDATE`, the child sends itself `SIGKILL`, the same as
`kill -9`. No `finally`, no `ROLLBACK`. The OS closes the socket, Postgres
aborts the transaction and releases the row lock, and `published_at` stays NULL.
The parent waits until the dead relay's lock is gone (`SKIP LOCKED` skips it
until then), then relays again.

### At-least-once, not exactly-once

`demo:crash-relay` is the proof. The same event was delivered twice
(`deliveries=2`), and the effect happened once (`applied=1`, `effect=1`). Delivery
is **at-least-once**: exactly-once delivery between a database and a broker
does not exist (the two generals problem). The exactly-once **result** comes
from the consumer's inbox + natural key, not from RabbitMQ.

### Why publish and `UPDATE published_at` cannot be swapped

If the relay marked the row first and then crashed (or publish failed), the
row would say "published" while the broker never got it: a **lost** event that
nothing will ever retry. With publish first, the worst case is a crash before
the mark, so the event is published **again**. The choice is between a duplicate
and a loss. A duplicate is fixed by dedup on the consumer; a loss is fixed by
nothing. Also, a publish error does not prove the message was not delivered
(the confirm may be what got lost), which is another reason the consumer dedups
no matter how careful the relay is.

### Notes

- **Ordering.** `ORDER BY created_at, id` only orders the *selection*. With
  `SKIP LOCKED` and several relays, delivery order is not guaranteed, and this
  project does not need it. If it did, ordering would only exist per partition
  key (`aggregate_id`). The relay selects by `published_at IS NULL`, not by an
  id cursor: an id is assigned at insert, the row becomes visible at COMMIT,
  so an id cursor skips rows.
- **One client per transaction.** The business op uses `dataSource.transaction`;
  relay and consumer use `pool.connect()`. Never `pool.query('BEGIN')`.
- **Outbox cleanup (implemented).** `purgeOutbox()` in
  `src/outbox/retention.ts` deletes published outbox rows older than 7 days
  and `processed_messages` marks older than 30 days, in batches of 1000
  (`DELETE … WHERE id IN (SELECT … LIMIT 1000)`) so a backlog never holds long
  locks. Indexes `idx_outbox_published_at` and
  `idx_processed_messages_processed_at` keep the sweep from scanning the whole
  table. Pending and parked rows (`published_at IS NULL`) are never deleted.
  Since HW-23 the sweep runs every 10 minutes as the BullMQ `outbox-purge`
  job scheduler (`npm run worker`) instead of a timer in the relay;
  `npm run outbox:purge` still runs it once. Inbox retention (30 days) is
  longer than outbox retention (7 days), so a message cannot be redelivered
  after its mark is gone. At much larger volumes the next step is to partition
  `outbox` by `created_at` and drop old partitions instead of deleting rows.
- **Relay retry limit.** Each row is confirmed by the broker separately. A
  row the broker refuses gets `attempts + 1` and `last_error`. The relay only
  selects `attempts < 5` (`RELAY_MAX_ATTEMPTS`), so after 5 failed publishes
  a poison row is **parked**: it stays in the table with its error for a
  human, and it stops blocking `drainOutbox`. Infrastructure failures (closed
  channel, DB error) roll the batch back without touching `attempts`, so a
  broker outage cannot park healthy rows.
- **Consumer retry policy.** Transient DB errors (lost connection, `08xxx`,
  deadlock, serialization failure, admin shutdown) are retried in-process 3
  times with 100/200 ms backoff. If the DB is still unavailable, the message
  goes back to the queue with `reject(requeue=true)`; RabbitMQ 4.2 quorum
  queues increment `x-delivery-count` on each requeue (checked). After 5
  redeliveries (`CONSUMER_MAX_REDELIVERIES`) it goes to the DLQ. Permanent
  errors (constraint/data errors) and malformed events go to the DLQ right
  away. A short DB blip no longer sends events to the DLQ.
- **Relay holds the row lock while publishing.** That is what makes a second
  relay skip in-flight rows. The cost is a transaction open across a network
  call, bounded by the batch size (`RELAY_BATCH_SIZE = 50`).
- Running it outside demos: `npm run consumer` (declares topology, consumes),
  `npm run relay` (polls every 500 ms), `npm run worker` (BullMQ) and
  `npm run outbox:purge` (one-shot sweep). The relay never declares topology.
  With `REDIS_QUEUE_URL` set, the consumer also enqueues `send-receipt`.

## CI/CD

Merging `hw-32` is gated by `.github/workflows/pr.yml`. Pushing `main` (and a manual run) is `.github/workflows/deploy.yml`. The image is built in one job. The deploy job takes that job's digest output and gives the same digest to kind. Nothing in the deploy workflow builds an image.

```
pull_request / workflow_dispatch
  build
    types (tsc + style lint) → contract (OpenAPI diff) → architecture (dependency-cruiser)
    → one image build → GHCR → scan
  deploy  (needs build; the only job with id-token: write)
    OIDC signature gate → kind → pulumi preview → cost gate → pulumi up → demo:rollout
    → upload pipeline-evidence (always)
push main / workflow_dispatch
  deploy
    same OIDC gate, then pull the digest that was already built and pulumi up
```

The cluster is kind (`hw28`) on the runner, namespace `marketplace`, Pulumi stack `dev`, file backend. There is no GitHub Environment, so the token subject is `repo:…:pull_request` or `repo:…:ref:refs/heads/…`, not `environment:prod`. The registry is GHCR, `ghcr.io/andriiblagodyr/nodejs-advanced-homeworks`. The workflow asks GitHub to make that package public; the job token often gets 404 for that call, so the package has to be switched to public once in the package settings. A private package still deploys, and the grader then checks the digest only from the artifact. The image scan in that pipeline uses `SCAN_MAX=50`. `demo:gates` is what proves the same scanner fails at `-1` and passes at `99999`.

The trust file is `oidc/policy.json`. `scripts/oidc-gate.mjs` fetches the issuer's OpenID configuration and JWKS, checks the signature, then `iss`, `aud` and `sub`. A token from any other repository fails the subject check even when the signature and audience are valid.

| Secret | What it is for |
| --- | --- |
| `NPM_TOKEN` | BuildKit secret for `npm ci` inside the image. The course registry is not private; the workflow substitutes a random value when this is unset. |
| `PACT_BROKER_URL` | Optional broker for the contract workflow. |
| `PACT_BROKER_TOKEN` | Optional broker token for the contract workflow. |

`GITHUB_TOKEN` is the job token (packages and the id token). It is not a long-lived cloud key. No AWS, GCP or Azure key is stored as a repository secret.

| Variable | Where it lives | What it is for |
| --- | --- | --- |
| `APP_DB_PASSWORD` | сховище (#11) | Postgres password; the pod reads it from the K8s Secret as `DB_PASSWORD` |
| `JWT_PRIVATE_KEY` | сховище (#11) | base64 PKCS#8 P-256 PEM |
| `JWT_PUBLIC_KEY` | сховище (#11) | base64 SPKI PEM of the same key |
| `JWT_KID` | сховище (#11) | key id |
| `REFRESH_TOKEN_PEPPER` | сховище (#11) | HMAC pepper for refresh tokens |
| `PULUMI_CONFIG_PASSPHRASE` | сховище (#11) | encrypts the local Pulumi state file |

GitHub's log mask replaces an exact copy of a secret value. It does not know that the value was base64-encoded, split, or printed by a tool in some other shape. Actions prints the job environment at the start of every later step, so the values generated for the job are registered with that mask before they are stored. This pipeline does not `echo` a secret and does not run `printenv` or `set -x` in a step that can see one. That is the sixth place a secret can leak, after git history, application logs, an image layer, `docker inspect` and `docker history`.

`src/mapping.ts` prices pod CPU and memory requests and multiplies each pair by the deployment replica count. The rates are the public AWS Fargate Linux/x86 prices (https://aws.amazon.com/fargate/pricing/): $0.04048 per vCPU-hour and $0.004445 per GB-hour, times 730 hours. The gate compares that sum with `COST_BUDGET_USD`. A pull request label skips the gate.

cost-gate-bypass-label: cost-approved

## Grading

No cloud account. The observability stand is the Jaeger / Prometheus /
Grafana services in `docker-compose.yml` (ports `22900–22999`). The grader
has no vault, so the block uses `SKIP_VAULT=1` and one-time values: a
one-time ES256 pair and pepper (the API still boots under the HW-24
guards). The pair lives only in a temp dir that is deleted right after it
is exported. The DB password is read from the local `db` container.

```bash
docker compose up -d --wait
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:22918
export PROMETHEUS_URL=http://127.0.0.1:22901
export TRACE_API_URL=http://127.0.0.1:22904
export SKIP_VAULT=1
export DATABASE_URL="postgres://app:$(docker compose exec -T db printenv POSTGRES_PASSWORD)@127.0.0.1:5432/marketplace"
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export REDIS_URL=redis://127.0.0.1:6390
export REDIS_QUEUE_URL=redis://127.0.0.1:6391
export STORAGE_ENDPOINT=http://127.0.0.1:22650
export STORAGE_REGION=us-east-1
export STORAGE_ACCESS_KEY=hw26user
export STORAGE_SECRET_KEY=hw26secretpass
export STORAGE_BUCKET=hw26-files
export JWT_KID=grader
KEYS="$(mktemp -d)"
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs"), dir=process.argv[1];
fs.writeFileSync(dir+"/priv.b64",Buffer.from(k.privateKey).toString("base64"),{mode:0o600});
fs.writeFileSync(dir+"/pub.b64",Buffer.from(k.publicKey).toString("base64"));' "$KEYS"
export JWT_PRIVATE_KEY="$(cat "$KEYS/priv.b64")"
export JWT_PUBLIC_KEY="$(cat "$KEYS/pub.b64")"
rm -rf "$KEYS"
export REFRESH_TOKEN_PEPPER="$(openssl rand -hex 32)"
npm ci
npm run demo:logs
npm run demo:metrics
npm run demo:trace
```

`--wait` is required: Jaeger has to accept OTLP before `demo:trace`.
`npm run start` without the auth or storage secrets still exits non-zero
and names every missing variable; it does not open the database first. The
HW-28 cluster commands (`image:build`, `cluster:up`, `up`, `demo:rollout`)
and the HW-26/24 demos still run under the same repo.

HW-32, from a clean checkout. The three commands do not need a cluster or GitHub. `gate:cost` reads a `plan.json` produced by a pipeline run; it is not committed.

```bash
git clone https://github.com/AndriiBlagodyr/nodejs-advanced-homeworks.git
cd nodejs-advanced-homeworks
git checkout hw-32
npm ci
export SKIP_VAULT=1
export APP_DB_PASSWORD=grader-secret
export JWT_PRIVATE_KEY=grader-secret
export JWT_PUBLIC_KEY=grader-secret
export JWT_KID=grader
export REFRESH_TOKEN_PEPPER=grader-secret
npm run demo:gates
npm run demo:oidc
PLAN_JSON=/tmp/hw32/plan.json COST_BUDGET_USD=0 npm run gate:cost
```
