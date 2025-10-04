import { NATS } from '../src/index.js';

(async () => {
    const connectionConfig = { servers: 'nats://localhost:4222', name: 'demo-client' };
    const nats = new NATS(connectionConfig, { defaultTimeout: 2000 });

    // вызов RPC-метода
    try {
        const sum = await nats.call('math.add', { a: 2, b: 3 }, {timeout: 1000});
        console.log('RPC result: 2 + 3 =', sum);
    } catch (err) {
        console.error('RPC error code:', err);
    }

    // публикация события user.created (fire-and-forget)
    await nats.emit('user.created', { id: '1234', name: 'Alice (demo)' });   

    process.stdin.resume();
})();
