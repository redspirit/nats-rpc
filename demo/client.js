import { NATS } from '../src/index.js';

(async () => {
    const connectionConfig = { servers: 'nats://localhost:4222', name: 'demo-client' };
    const nats = new NATS(connectionConfig, { defaultTimeout: 2000 });

    const mathService = nats.getService('math');
    const add = mathService.fn('add');
    const sqrt = mathService.fn('sqrt');


    // вызов RPC-метода
    try {
        const sum = await add(2, 3);
        console.log('RPC result: 2 + 3 =', sum);

        const res = await sqrt(81);
        console.log('RPC result sqrt 81 =', res);
    } catch (err) {
        console.error('RPC error code:', err);
    }

    // публикация события user.created (fire-and-forget)
    await nats.emit('user.created', { id: '1234', name: 'Alice (demo)' });   

    process.stdin.resume();
})();
