# nats-rpc

Простая и удобная RPC- и pub/sub-обёртка над [NATS](https://nats.io/) для Node.js.
Позволяет вызывать методы между микросервисами как обычные async-функции и работать с событиями (fire-and-forget).

---

## Установка

```bash
npm install nats-rpc
```

---

Если планируете использовать JetStream (persist), убедитесь, что NATS сервер запущен с поддержкой JetStream.

Простой `docker-compose.yml` (для локальной разработки):

```yaml
version: '3.7'
services:
  nats:
    image: nats:latest
    command: -js
    ports:
      - "4222:4222"
      - "8222:8222"
```

Запустите: `docker compose up` — сервер с JetStream будет доступен на `nats://localhost:4222`.

---

## Быстрый старт

```javascript
import NATS from 'nats-rpc';

(async () => {
  const nats = new NATS({ servers: 'nats://localhost:4222' }, { defaultTimeout: 2000 });
  await nats.connect();

  // Объявляем RPC сервис (нересурсный)
  await nats.service('math', {
    add: async (a, b) => a + b,
    sqrt: async (n) => Math.sqrt(n),
  });

  // Вызываем RPC
  const mathService = nats.getService('math');
  const add = mathService.fn('add');
  try {
    const sum = await add(2, 3);
    console.log('RPC result:', sum);
  } catch (err) {
    console.error('RPC error:', err);
  }

  // Подписка на событие (pub/sub)
  const sub = await nats.on('user.created', async (data) => {
    console.log('Event user.created ->', data);
  }, { queue: 'workers-group' }); // queue optional

  // Публикация события
  await nats.emit('user.created', { id: '1234', name: 'Alice' });

  // graceful shutdown
  await sub.unsubscribe();
  await nats.drain();
})();
```

---

## API

### Конструктор

```js
const nats = new NATS(connectionConfig, { defaultTimeout: 1000 });
```

`connectionConfig` — объект для `nats.connect()` (например `{ servers: 'nats://localhost:4222' }`).

`defaultTimeout` — таймаут для RPC (ms).

---

### service(name, handlers, serviceOpts)

Регистрирует обработчики RPC (в памяти, обычный request/reply). Для каждого метода создаётся подписка на subject `${name}.${method}`.

* `handlers`: `{ methodName: async (data, msg) => result }`
* `serviceOpts.queue` — queue group (по умолчанию имя сервиса)

Поведение: при успешном выполнении возвращает клиенту `{ __ok: true, result }`. При ошибке отправляет `{ __error: true, message, stack? }`.

### call(subject, data, options)

Выполняет RPC вызов. Опции:

* `timeout` (ms) — время ожидания ответа.

Ошибки (в `err.code`):

* `RPC_TIMEOUT` — истёк таймаут
* `RPC_NO_RESPONDERS` — нет слушателей
* `RPC_REMOTE_ERROR` — удалённый сервис вернул `{ __error: true }`

---

### on(subject, handler, opts)

Подписка на события (pub/sub).

* `opts` передаются в `nc.subscribe()` — можно указать `{ queue: 'group' }`.
* Возвращает объект `{ subj, sub, unsubscribe }`.

---

### emit(subject, data, options)

Публикация события (fire-and-forget).

* `options` проксируются в `nc.publish()`.
* Специальная опция `skipFlush: true` — не ждать `flush()`.

---

## Изменение поведения ACK/NACK (опционально)

По умолчанию `servicePersist` делает `m.ack()` даже при ошибке обработчика — это предотвращает бесконечные повторные доставки и считается безопасным для большинства сценариев, где служба сама отвечает клиенту об ошибке. Если вы хотите, чтобы сообщение повторно доставлялось при ошибке, замените `m.ack()` на `m.na

---

## Отладка / частые проблемы

* **NO_RESPONDERS / 503** при `call()` — если нет слушателей, библиотека нормализует ошибку и выдаёт `err.code === 'RPC_NO_RESPONDERS'`.
* **RPC_TIMEOUT** — сервис не ответил в указанное время. Проверьте, запущен ли слушатель и нет ли сетевых проблем.

---

## Советы

* Для высокой пропускной способности отключайте `flush()` при `emit()` (`skipFlush: true`).
* Для упрощения горизонтального масштабирования используйте `servicePersist` с `queue` — несколько экземпляров сервиса будут балансироваться.
* Для критичных сообщений можете хранить ответы в отдельном stream, если клиент может быть оффлайн.