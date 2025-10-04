import { NATS } from '../src/index.js';

(async () => {
    const connectionConfig = { servers: 'nats://localhost:4222', name: 'demo-server' };
    const nats = new NATS(connectionConfig, { defaultTimeout: 2000 });

    // объявялем RPC методы
    nats.service('math', {
        add: async (data) => {
            return data.a + data.b;
        },
        sqrt: async (data) => {
            return Math.sqrt(data.n);
        },
    });

    // подписываемся на событие user.created
    await nats.on('user.created111', async (data) => {
        console.log('Event received: user.created ->', data);
    });

    console.log('Service running (demo/server.js)...');

    // держим процесс живым
    process.stdin.resume();
})();
