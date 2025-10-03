import { RPC } from '../src/index.js';

(async () => {
    // клиент для RPC вызовов в сервис math
    const math = new RPC('math');

    // клиент для публикации событий user
    const user = new RPC('user');

    // вызов RPC-метода
    try {
        const sum = await math.call('add', { a: 2, b: 3 });
        console.log('RPC result: 2 + 3 =', sum);
    } catch (err) {
        console.error('RPC error:', err);
    }

    // публикация события (fire-and-forget)
    await user.emit('created', { id: Date.now(), name: 'Alice (demo)' });
    console.log('Published event: user.created');

    process.stdin.resume();
})();
