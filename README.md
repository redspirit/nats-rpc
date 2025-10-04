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
    add: async (data) => data.a + data.b,
    sqrt: async (data) => Math.sqrt(data.n),
  });

  // Вызываем RPC
  try {
    const sum = await nats.call('math.add', { a: 2, b: 3 });
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

## JetStream (persist) API

> JetStream обеспечивает устойчивость сообщений при временной недоступности потребителей.

### callPersist(subject, data, options)

Публикует RPC-запрос в JetStream и ожидает ответа на временный reply-inbox.

Опции:

* `timeout` (ms) — время ожидания ответа (по умолчанию `defaultTimeout`)
* `jsStreamOptions` — опции при создании stream (передаются в `ensureStreamForSubject`, например `{ no_ack: true }`)

Ошибки (в `err.code`):

* `RPC_TIMEOUT` — не получили ответ в пределах `timeout`
* `RPC_REMOTE_ERROR` — служба вернула `{ __error: true }`
* `RPC_NO_REPLY` — не получили reply (редкий случай)

**Замечание:** `callPersist` гарантирует, что запрос попадёт в JetStream, но reply по-прежнему доставляется в реальном времени на временный inbox — клиент должен оставаться подключённым пока ждёт ответ. Если нужен оффлайн-ответ — требуется отдельный паттерн (хранение ответов в JetStream).

### servicePersist(name, handlers, serviceOpts)

Регистрирует устойчивые обработчики, которые читают запросы из JetStream (durable consumer).

* `serviceOpts.queue` — delivery group (внутренняя load balancing)
* `serviceOpts.streamOpts` — опции при создании stream (передаются в ensureStreamForSubject)

Поведение:

* После успешной обработки отправляет ответ на `reply` subject (если он указан) и `ack()` сообщение.
* При ошибке отправляет `{ __error: true, ... }` на `reply` и также `ack()` сообщение (чтобы не было повторных доставок). Если требуется повторы при ошибке — можно изменить логику ACK/NACK в коде (см. раздел «Изменение поведения ACK/NACK»).

---

## Примеры: JetStream RPC

```js
// Сервер (устойчивый)
await nats.servicePersist('math', {
  add: async (data) => data.a + data.b,
}, { queue: 'math-workers', streamOpts: { no_ack: true } });

// Клиент
try {
  const res = await nats.callPersist('math.add', { a: 5, b: 6 }, { timeout: 10000 });
  console.log('res', res);
} catch (err) {
  if (err.code === 'RPC_TIMEOUT') console.error('timeout');
  else if (err.code === 'RPC_REMOTE_ERROR') console.error('remote error', err.remoteStack);
  else console.error(err);
}
```

---

## Изменение поведения ACK/NACK (опционально)

По умолчанию `servicePersist` делает `m.ack()` даже при ошибке обработчика — это предотвращает бесконечные повторные доставки и считается безопасным для большинства сценариев, где служба сама отвечает клиенту об ошибке. Если вы хотите, чтобы сообщение повторно доставлялось при ошибке, замените `m.ack()` на `m.nak()` или пропустите `ack()` (требуется аккуратно настроить `max Deliver` и retry/Backoff на стороне JetStream consumer).

---

## Отладка / частые проблемы

* **NO_RESPONDERS / 503** при `call()` — если нет слушателей, библиотека нормализует ошибку и выдаёт `err.code === 'RPC_NO_RESPONDERS'`.
* **RPC_TIMEOUT** — сервис не ответил в указанное время. Проверьте, запущен ли слушатель и нет ли сетевых проблем.
* **JetStream ошибки при publish** — убедитесь, что NATS сервер запущен с `-js` и имеется доступ к менеджеру JetStream (проверьте лог сервера).

---

## Советы

* Для высокой пропускной способности отключайте `flush()` при `emit()` (`skipFlush: true`).
* Для упрощения горизонтального масштабирования используйте `servicePersist` с `queue` — несколько экземпляров сервиса будут балансироваться.
* Для критичных сообщений можете хранить ответы в отдельном stream, если клиент может быть оффлайн.