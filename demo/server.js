import { RPC } from '../src/index.js';

(async () => {
    const rpc = new RPC('math', 'nats://localhost:4222');

    // регистрируем RPC-метод math.add
    await rpc.method('add', async ({ a, b }) => {
        console.log(`Handling math.add: ${a} + ${b}`);
        return a + b;
    });

    // подписываемся на событие user.created
    await rpc.on('user.created', async (data) => {
        console.log('Event received: user.created ->', data);
    });

    console.log('Math service running (demo/server.js)...');

    // держим процесс живым
    process.stdin.resume();
})();
