# nats-rpc

Простая и удобная RPC- и pub/sub-обёртка над [NATS](https://nats.io/) для Node.js.
Позволяет вызывать методы между микросервисами как обычные async-функции и работать с событиями (fire-and-forget).

---

## 📦 Установка

```bash
npm install nats-rpc
```

Также потребуется запущенный NATS-сервер (по умолчанию `nats://localhost:4222`):

```bash
docker run -d --name nats-server -p 4222:4222 -p 8222:8222 nats
```

---

## 🚀 Быстрый старт

### 1) Создание RPC-сервиса

```js
// math-service.js
import { RPC } from "nats-rpc-easy";

const rpc = new RPC("math");

await rpc.method("add", async ({ a, b }) => a + b);
await rpc.method("mul", async ({ a, b }) => a * b);

console.log("Math service running...");
```

### 2) Вызов методов с клиента

```js
// client.js
import { RPC } from "nats-rpc-easy";

const math = new RPC("math");

const run = async () => {
  const sum = await math.call("add", { a: 2, b: 3 });
  const mul = await math.call("mul", { a: 4, b: 5 });

  console.log("2 + 3 =", sum);
  console.log("4 * 5 =", mul);
};

run();
```

---

## 🔔 Pub/Sub (события)

### Отправка события (fire-and-forget)

```js
import { RPC } from "nats-rpc-easy";

const user = new RPC("user");

await user.emit("created", { id: 1, name: "Alice" });
console.log("Event sent: user.created");
```

### Подписка на событие

```js
import { RPC } from "nats-rpc-easy";

const user = new RPC("user");

await user.on("created", async (data) => {
  console.log("New user created:", data);
});
```

---

## 🎯 Отправка сообщения только одному клиенту

Если нужно, чтобы сообщение получил **только один** обработчик из нескольких — используйте **queue group**.

```js
// worker1.js
await rpc.on("jobs.process", async (job) => {
  console.log("Worker 1 processed:", job);
}, "workers");

// worker2.js (тоже в группе "workers")
await rpc.on("jobs.process", async (job) => {
  console.log("Worker 2 processed:", job);
}, "workers");

// publisher.js
await rpc.emit("jobs.process", { task: "resize-image" });
```

В этом случае только один из подписчиков в группе `workers` получит сообщение.

---

## ⚙️ API

### Конструктор

```js
const rpc = new RPC(serviceName?, url?);
```

* `serviceName` — (опционально) строка, добавляется как префикс к subject: `serviceName.method`.
* `url` — адрес NATS-сервера. По умолчанию `nats://localhost:4222`.

### Методы

* `await rpc.method(name, handler)` — регистрирует RPC-метод. `handler` может быть async и должен вернуть результат.
* `await rpc.call(name, data, timeout?)` — вызывает RPC-метод и возвращает результат. `timeout` в миллисекундах (по умолчанию `1000`).
* `await rpc.emit(event, data)` — отправляет событие (fire-and-forget) всем подписчикам.
* `await rpc.on(event, handler, queueGroup?)` — подписка на событие; опционально указывается `queueGroup` для балансировки нагрузки.

---

## 💡 Полезные советы

* **Типизация и контракты:** NATS передаёт данные как строки/байты — рекомендуется придерживаться согласованного JSON-схемы (или использовать protobuf в более сложных случаях).
* **Timeouts:** задавайте реалистичный `timeout` для `call`, чтобы избежать блокировок клиентов при неответе сервиса.
* **Health & retries:** учитывайте попытки повторной отправки/повторного соединения в продакшене. NATS клиент автоматически пытается переподключиться, но обработку логики повторов на уровне приложений стоит предусмотреть.

---

## 🧪 Пример docker-compose (локальная разработка)

```yaml
services:
  nats:
    image: nats:latest
    ports:
      - "4222:4222"
      - "8222:8222" # monitoring
```

Запускает локальный nats-server, доступный по `nats://localhost:4222`.

---

## 🛠️ Отладка

* Проверьте, что `nats-server` слушает на ожидаемом порту.
* В логах NATS (порт `8222`) можно посмотреть метрики и активность.
* Если `rpc.call` выбрасывает таймаут — увеличьте `timeout` или проверьте что сервис с методом действительно запущен.

---

## 📜 Лицензия

MIT © 2025
